import type { CueSheet, SheetStatus } from "./types";

/**
 * Derive the sheet's real completion state.
 *
 * The rule this module exists to enforce: success is never inferred from the
 * HTTP status, from the presence of an API key, or from `mode: "live"`. All
 * three reported success for a sheet that carried zero cues because the Qloo key
 * was rejected. The state is read from what actually happened instead — the
 * receipts for the calls that ran, and the scene read.
 *
 * Which integrations are required is a property of the workflow, not of the
 * deployment:
 *
 *  - **Required:** the Qloo artist-affinity call. It is the ranking, so if it did
 *    not return rows the requested workflow could not complete: `failed`.
 *  - **Conditionally required:** the scene reader, but only when a model is
 *    configured. A configured model that did not produce the brief means the
 *    brief is the deterministic parser's — usable, but not what was promised, so
 *    that is `degraded`.
 *  - **Optional:** cross-domain, comparables, casting, regional affinity and
 *    momentum. Each degrades its own panel, so their failure is `degraded`.
 *
 * A required call that returned 200 and matched nothing is a real absence of
 * results: `empty`. That is deliberately not an error. "Qloo found no artists
 * for this brief" and "the key was rejected" are different facts, and a reader
 * has to be able to tell them apart.
 */

/** The label `groundArtistCues` gives its receipt. The one required call. */
const ARTIST_AFFINITY_LABEL = "Artist affinity (explainability on)";

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** 0 is the transport layer's code for a timeout or a network failure. */
function isUnavailableStatus(status: number): boolean {
  return status === 0 || status >= 500;
}

function describeFault(endpoint: string, label: string, status: number): string {
  const cause = isAuthStatus(status)
    ? "was rejected as unauthorised"
    : isUnavailableStatus(status)
      ? "did not respond"
      : `returned ${status}`;
  return `${label} (${endpoint}) ${cause}.`;
}

export function computeSheetStatus(sheet: CueSheet): SheetStatus {
  if (sheet.mode === "fixture") {
    return {
      kind: "fixture",
      label: "fixture",
      detail:
        "No Qloo key is configured, so this is a cached, pre-computed example rather than live output.",
      reasons: [],
    };
  }

  const { receipts, cues, sceneParse, llmConfigured } = sheet;
  const primary = receipts.find((receipt) => receipt.label === ARTIST_AFFINITY_LABEL);

  // Did the required step actually produce a ranking? This, not the HTTP status
  // of the response, is what "the workflow completed" means.
  const ranked = primary !== undefined && primary.status === 200 && primary.resultCount > 0;

  if (!ranked) {
    // No receipt at all: the call never ran, which is a pipeline fault rather
    // than anything Qloo reported.
    if (!primary) {
      return {
        kind: "failed",
        label: "failed",
        detail: "The Qloo ranking call did not run, so the sheet was never scored.",
        reasons: ["The artist-affinity call left no receipt."],
      };
    }

    // A rejected credential is the case that used to read as success. It is
    // reported as failed, and named as authentication so it is not confused with
    // an absence of matches. One rejected key fails every call it touches, so the
    // ranking call is named and the rest are summarised: nine identical lines
    // would bury the fact rather than report it.
    if (isAuthStatus(primary.status)) {
      const others = receipts.filter(
        (receipt) => receipt !== primary && isAuthStatus(receipt.status),
      );
      return {
        kind: "failed",
        label: "failed",
        detail:
          "Qloo rejected the API key, so no artist could be ranked. This is an authentication failure, not an absence of results.",
        reasons: [
          describeFault(primary.endpoint, primary.label, primary.status),
          ...(others.length > 0
            ? [
                `The same key was rejected for ${others.length} further call${
                  others.length === 1 ? "" : "s"
                }: ${[...new Set(others.map((receipt) => receipt.label))].join(", ")}.`,
              ]
            : []),
        ],
      };
    }

    // An outage or a timeout: the call was attempted and the provider did not
    // answer. Distinct from both a rejection and a genuine empty result.
    if (isUnavailableStatus(primary.status)) {
      return {
        kind: "failed",
        label: "failed",
        detail:
          "Qloo did not respond to the ranking call, so the sheet could not be scored. This is an outage or timeout, not an absence of results.",
        reasons: [describeFault(primary.endpoint, primary.label, primary.status)],
      };
    }

    // A 200 that matched nothing. Qloo answered normally.
    if (primary.status === 200 && primary.resultCount === 0) {
      const otherFaults = receipts.filter(
        (receipt) => receipt !== primary && receipt.status !== 200,
      );
      // A genuine empty result, unless something else in the run also failed —
      // in which case the sheet is degraded and the reader should see both.
      if (otherFaults.length === 0) {
        return {
          kind: "empty",
          label: "no results",
          detail:
            "Qloo answered normally and matched no artists for this brief. Nothing failed — there was simply nothing to rank. Adding a named film, show or artist gives the ranking an anchor to work from.",
          reasons: [],
        };
      }
      return {
        kind: "degraded",
        label: "degraded",
        detail:
          "Qloo matched no artists for this brief, and other calls in the run also failed. Nothing here is a working ranking.",
        reasons: otherFaults.map((receipt) =>
          describeFault(receipt.endpoint, receipt.label, receipt.status),
        ),
      };
    }

    // Any other non-200: a request-shape or coverage fault, named by its status.
    return {
      kind: "failed",
      label: "failed",
      detail: "The Qloo ranking call failed, so the sheet could not be scored.",
      reasons: [describeFault(primary.endpoint, primary.label, primary.status)],
    };
  }

  // The ranking succeeded, so the sheet is usable. Everything below is a partial
  // failure: worth naming, never worth calling the whole workflow failed.
  const reasons: string[] = [];

  if (llmConfigured && sceneParse?.source === "deterministic") {
    reasons.push(
      sceneParse.failureMessage
        ? `The scene reader fell back to the deterministic parser because ${sceneParse.failureMessage}. The brief is parser-generated, not model-generated.`
        : "A model is configured but the scene reader did not produce the brief. The brief is parser-generated, not model-generated.",
    );
  }

  // The model ran the scene read but named no tracks, so the track-naming call is
  // the one that failed. Only a fault when a model is actually configured.
  if (
    llmConfigured &&
    sceneParse?.source === "llm" &&
    cues.length > 0 &&
    cues.every((cue) => cue.trackUnverified)
  ) {
    reasons.push(
      "The scene reader ran, but no concrete track was proposed, so every cue is a pending selection rather than a named cut.",
    );
  }

  for (const receipt of receipts) {
    if (receipt === primary || receipt.status === 200) continue;
    reasons.push(describeFault(receipt.endpoint, receipt.label, receipt.status));
  }

  // A single upstream fault often surfaces on several calls at once. Cap the list
  // so the panel stays readable, and say how many were withheld rather than
  // dropping them silently.
  const MAX_REASONS = 6;
  const trimmed =
    reasons.length > MAX_REASONS
      ? [
          ...reasons.slice(0, MAX_REASONS),
          `…and ${reasons.length - MAX_REASONS} further call${
            reasons.length - MAX_REASONS === 1 ? "" : "s"
          } did not return 200.`,
        ]
      : reasons;

  if (trimmed.length > 0) {
    return {
      kind: "degraded",
      label: "degraded",
      detail:
        "The cue sheet is usable, but part of the workflow did not complete. The ranking below is Qloo's; the notes list what is missing.",
      reasons: trimmed,
    };
  }

  return {
    kind: "live",
    label: "live",
    detail: llmConfigured
      ? "Every required step ran: the model read the scene and Qloo ranked the artists by measured audience affinity."
      : "Qloo ranked the artists by measured audience affinity. No model is configured, so the brief comes from the deterministic reader.",
    reasons: [],
  };
}
