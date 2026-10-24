"use client";

import type { CueSheet } from "@/lib/types";

/**
 * The receipt panel.
 *
 * Judges and practitioners both ask the same question: "is this actually
 * calling Qloo, or is it a wrapper around an LLM?" This renders every endpoint
 * that ran, its parameters, status and latency, so the answer is inspectable
 * rather than asserted.
 */
export function ReceiptsPanel({ sheet }: { sheet: CueSheet }) {
  const live = sheet.mode === "live";
  const totalMs = sheet.receipts.reduce((sum, receipt) => sum + receipt.ms, 0);
  const failures = sheet.receipts.filter((receipt) => receipt.status !== 200).length;
  // The badge reflects the workflow's real state, not just that live calls were
  // attempted. A sheet whose key was rejected is "live" by mode and failed in
  // fact, and the badge must not show green for it.
  const statusKind = sheet.status?.kind;
  const badgeText = sheet.status ? sheet.status.label : live ? "live" : "fixture";
  const badgeTone =
    statusKind === "live"
      ? "border-signal-500/30 bg-signal-500/10 text-signal-400"
      : statusKind === "empty"
        ? "border-white/10 bg-white/5 text-haze-300"
        : statusKind === "failed" || statusKind === "degraded"
          ? "border-ember-500/30 bg-ember-500/10 text-ember-400"
          : live
            ? "border-signal-500/30 bg-signal-500/10 text-signal-400"
            : "border-ember-500/30 bg-ember-500/10 text-ember-400";

  return (
    <section id="receipts" className="panel grain relative scroll-mt-20 overflow-hidden p-5" aria-label="Qloo call receipts">
      <div className="relative z-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base text-haze-100">Qloo receipts</h3>
            <p className="mt-0.5 text-xs text-haze-500">
              Every call Cue made, with the parameters it sent.
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wider ${badgeTone}`}
          >
            {badgeText}
          </span>
        </header>

        <dl className="mt-4 grid grid-cols-3 gap-3 border-y border-white/5 py-3">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">Calls</dt>
            <dd className="font-mono text-lg text-haze-100">{sheet.receipts.length}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">Endpoints</dt>
            <dd className="font-mono text-lg text-haze-100">
              {new Set(sheet.receipts.map((receipt) => receipt.endpoint)).size}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-haze-500">Total</dt>
            <dd className="font-mono text-lg text-haze-100">{totalMs}ms</dd>
          </div>
        </dl>

        <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {sheet.receipts.map((receipt, index) => (
            <li
              key={`${receipt.endpoint}-${index}`}
              className="rounded-lg border border-white/5 bg-black/20 p-2.5"
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                {/* Endpoint paths must stay fully readable: this panel is the
                    evidence that every number came from a real Qloo call, so
                    truncating the path would undercut the whole claim. */}
                <code className="break-all font-mono text-[11px] text-signal-300">
                  {receipt.endpoint}
                </code>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
                  <span
                    className={
                      receipt.status === 200 ? "text-signal-400" : "text-ember-400"
                    }
                  >
                    {receipt.status || "ERR"}
                  </span>
                  <span className="text-haze-500">{receipt.ms}ms</span>
                  <span className="text-haze-500">{receipt.resultCount} rows</span>
                </span>
              </div>
              <p className="mt-1 text-[11px] text-haze-300">{receipt.label}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-haze-500 hover:text-haze-300">
                  parameters
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded border border-white/5 bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-haze-300">
                  {JSON.stringify(receipt.params, null, 2)}
                </pre>
              </details>
              {receipt.note ? (
                <p className="mt-1 text-[10px] leading-relaxed text-ember-400">{receipt.note}</p>
              ) : null}
            </li>
          ))}
          {sheet.receipts.length === 0 ? (
            <li className="rounded-lg border border-white/5 bg-black/20 p-3 text-xs text-haze-500">
              No calls recorded.
            </li>
          ) : null}
        </ul>

        {failures > 0 ? (
          <p className="mt-3 text-xs text-ember-400">
            {failures} call{failures === 1 ? "" : "s"} did not return 200.
            {sheet.status?.kind === "failed"
              ? " The workflow could not complete; the status above says which integration failed."
              : " Cue degrades per-call rather than failing the sheet."}
          </p>
        ) : null}
      </div>
    </section>
  );
}
