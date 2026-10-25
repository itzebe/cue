import type { Cue } from "./types";

/**
 * The Qloo ON/OFF counterfactual, computed rather than asserted.
 *
 * The hackathon's eligibility test is blunt: "if your submission would work the
 * same without Qloo, you're building the wrong thing." That is a claim about a
 * difference, and a difference is a measurement. This module produces the
 * measurement from two slates the pipeline already holds — the Qloo-grounded cue
 * sheet and the model's ungrounded answer — so the claim is shown, not stated.
 *
 * Two rules keep it honest:
 *
 *  1. Every number here is arithmetic over the two visible lists. Nothing is
 *     scored, weighted or inferred. The overlap is a count of shared names and is
 *     described as one, never as a quality verdict.
 *  2. The comparison never calls an absent field a "failure". The ungrounded
 *     answer is a fair, best-effort model answer; it simply has no cultural data
 *     to work from, so measured fields are structurally absent rather than wrong.
 *     The module reports the absence and attributes it to the missing data.
 */

/** A measured field a Qloo-grounded cue carries and an ungrounded answer cannot. */
export interface GroundedCapability {
  /** Stable key, used by tests and the UI. */
  key: string;
  /** What the field is, in the reader's terms. */
  label: string;
  /** Why an ungrounded answer cannot produce it. */
  because: string;
}

/**
 * The fields whose presence is decided by the taste graph, not by the model.
 *
 * This is the substance of the counterfactual: it is not that the ungrounded
 * answer names worse artists (that is opinion), it is that the ungrounded answer
 * carries none of these columns, because each one is a measurement the model has
 * no instrument to take.
 */
export const GROUNDED_CAPABILITIES: GroundedCapability[] = [
  {
    key: "affinity",
    label: "Measured affinity against the scene's taste profile",
    because: "an affinity is a population measurement, not a property of the text",
  },
  {
    key: "audienceFit",
    label: "Audience fit by age cohort",
    because: "it is read from the same audience the anchors index against",
  },
  {
    key: "momentum",
    label: "Trend momentum",
    because: "it comes from the entity's movement in Qloo's population rank",
  },
  {
    key: "explainability",
    label: "Explainability — which signals produced the score",
    because: "there is no score to explain without a measurement behind it",
  },
  {
    key: "clearance",
    label: "Clearance readiness",
    because: "it is inferred from the measured popularity of the entity",
  },
  {
    key: "image",
    label: "Artist artwork",
    because: "it is an attribute of the resolved Qloo entity",
  },
];

/** One side of the comparison, reduced to what can be counted. */
export interface GroundingSide {
  /** How many picks the side offers. */
  count: number;
  /** How many of those picks name a specific track. */
  namedTrackCount: number;
  /** Lowercased artist names, for set arithmetic. */
  artists: string[];
}

/** The full, pure result of comparing a grounded slate to an ungrounded one. */
export interface GroundingComparison {
  grounded: GroundingSide;
  ungrounded: GroundingSide;
  /**
   * Whether the ungrounded slate was actually produced by the model, or is a
   * fixed sample because the call failed. The UI must not present a sample as a
   * live model answer, so the comparison carries the fact rather than guessing.
   */
  ungroundedSource: "llm" | "sample";
  /** Artists both answers name, in the grounded slate's order. */
  sharedArtists: string[];
  /** Artists only the grounded slate names, in its order. */
  groundedOnlyArtists: string[];
  /** Artists only the ungrounded slate names, in its order. */
  ungroundedOnlyArtists: string[];
  /** Count of shared names. A count, not a score. */
  overlapCount: number;
  /** Shared names as a fraction of the union of both name sets, 0..1. */
  overlapRatio: number;
  /** Capability keys present on the grounded slate and absent from the other. */
  capabilitiesLost: string[];
  /** One factual sentence a reader can check against the two lists. */
  verdict: string;
}

function sideOf(cues: Array<{ artist: string; track?: string }>): GroundingSide {
  const artists = cues
    .map((cue) => (cue.artist ?? "").trim().toLowerCase())
    .filter((name) => name.length > 0);
  const namedTrackCount = cues.filter(
    (cue) => typeof cue.track === "string" && cue.track.trim().length > 0,
  ).length;
  return { count: cues.length, namedTrackCount, artists };
}

/** Which capabilities the grounded slate actually demonstrates. */
export function capabilitiesPresent(cues: Cue[]): string[] {
  const present = new Set<string>();
  for (const cue of cues) {
    if (Number.isFinite(cue.affinity) && cue.affinity > 0) present.add("affinity");
    if (cue.audienceFit && Object.keys(cue.audienceFit).length > 0) present.add("audienceFit");
    if (cue.momentum !== 0) present.add("momentum");
    if (Array.isArray(cue.explainability) && cue.explainability.length > 0) {
      present.add("explainability");
    }
    if (cue.clearance && cue.clearance !== "unknown") present.add("clearance");
    if (cue.image) present.add("image");
  }
  return GROUNDED_CAPABILITIES.map((c) => c.key).filter((key) => present.has(key));
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Compare the Qloo-grounded slate to the model's ungrounded answer.
 *
 * Pure: no network, no clock, no randomness. Given the same two slates it returns
 * the same object, which is what lets the figures be pinned in a test.
 */
export function compareGrounding(input: {
  grounded: Cue[];
  ungrounded: Array<{ artist: string; track?: string }>;
  ungroundedSource: "llm" | "sample";
}): GroundingComparison {
  const grounded = sideOf(input.grounded);
  const ungrounded = sideOf(input.ungrounded);

  const groundedNames = dedupe(grounded.artists);
  const ungroundedNames = dedupe(ungrounded.artists);
  const groundedSet = new Set(groundedNames);
  const ungroundedSet = new Set(ungroundedNames);

  // Order follows the grounded slate so the reader can trace each name back to a
  // row above it. `Set` iteration order would follow insertion and drift.
  const sharedArtists = groundedNames.filter((name) => ungroundedSet.has(name));
  const groundedOnlyArtists = groundedNames.filter((name) => !ungroundedSet.has(name));
  const ungroundedOnlyArtists = ungroundedNames.filter((name) => !groundedSet.has(name));

  const union = new Set([...groundedNames, ...ungroundedNames]);
  const overlapRatio = union.size === 0 ? 0 : sharedArtists.length / union.size;

  const present = new Set(capabilitiesPresent(input.grounded));
  const capabilitiesLost = GROUNDED_CAPABILITIES.map((c) => c.key).filter((key) =>
    present.has(key),
  );

  const overlapLine =
    grounded.count === 0 || ungrounded.count === 0
      ? "One side offered no picks, so there is nothing to compare."
      : sharedArtists.length === 0
        ? "The two answers name no artist in common."
        : `The two answers share ${sharedArtists.length} of the ${union.size} artists named across both.`;

  const capabilityLine =
    capabilitiesLost.length === 0
      ? ""
      : ` The ungrounded answer carries none of the ${capabilitiesLost.length} measured fields the grounded slate does — ${
          capabilitiesLost.length === 1 ? "that field is" : "those fields are"
        } a measurement, not an opinion.`;

  const sourceLine =
    input.ungroundedSource === "sample"
      ? " The ungrounded column is a fixed sample, not a live model answer, because the model call did not return one."
      : "";

  return {
    grounded,
    ungrounded,
    ungroundedSource: input.ungroundedSource,
    sharedArtists,
    groundedOnlyArtists,
    ungroundedOnlyArtists,
    overlapCount: sharedArtists.length,
    overlapRatio,
    capabilitiesLost,
    verdict: `${overlapLine}${capabilityLine}${sourceLine}`,
  };
}
