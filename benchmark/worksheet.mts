/**
 * Emit a blinded review worksheet for the human-preference metric.
 *
 * The metric is the only one that can answer the question the automated proxies
 * cannot: whether the recommendations are any good. It stays empty until real
 * people fill it in, and this script is what makes that possible without leaking
 * which arm is which.
 *
 * Blinding works in two layers:
 *
 *  1. Each brief's two answers are labelled X and Y by a deterministic hash of
 *     the protocol hash and the brief id. The label does not reveal the arm, and
 *     it is reproducible, so the mapping can be audited after unblinding.
 *
 *  2. The worksheet shows only artist and track for both arms. Arm B's `why`
 *     field is Qloo provenance boilerplate that would give it away, and its
 *     affinity and entity ids are withheld for the same reason. Arm A's `why` is
 *     withheld too, so the two arms are presented identically.
 *
 * Run: npx tsx benchmark/worksheet.mts
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = resolve(here, "evidence");
const reviewDir = resolve(here, "reviews");

const protocolRaw = readFileSync(resolve(here, "protocol.json"));
const protocol = JSON.parse(protocolRaw.toString("utf8"));
const protocolHash = createHash("sha256").update(protocolRaw).digest("hex");
const K: number = protocol.slateSizeParity.commonSlateSize;

const { topByAffinity } = await import("./lib.mts");

/** Deterministic per-brief label assignment. The parity of the hash decides. */
function labelMap(briefId: string): { X: "A" | "B"; Y: "A" | "B" } {
  const digest = createHash("sha256").update(`${protocolHash}:${briefId}`).digest();
  // Use one bit, so across six briefs the assignment is roughly balanced.
  return digest[0] % 2 === 0 ? { X: "A", Y: "B" } : { X: "B", Y: "A" };
}

const files = readdirSync(evidenceDir)
  .filter((n) => n.endsWith(".json") && !n.endsWith(".pool.json"))
  .sort();

const lines: string[] = [
  "# Blinded review worksheet",
  "",
  "Rate each answer 1-5 on relevance, variety and would-use. Then copy",
  "`reviews/TEMPLATE.json` to `reviews/<your-name>.json` and enter your ratings.",
  "",
  "X and Y are assigned per brief by a hash of the protocol file. They are stable",
  "and reproducible, and they do not mean first or second. Only artist and track",
  "are shown, so neither answer is identifiable from its presentation.",
  "",
  `Protocol hash: \`${protocolHash}\``,
  "",
];

const mapping: Record<string, { X: "A" | "B"; Y: "A" | "B" }> = {};

for (const file of files) {
  const evidence = JSON.parse(readFileSync(resolve(evidenceDir, file), "utf8"));
  const sheet = evidence.raw;
  const briefId = evidence.briefId;
  const labels = labelMap(briefId);
  mapping[briefId] = labels;

  const armA = (sheet.baseline?.cues ?? []).slice(0, K).map((c: any) => ({
    artist: String(c.artist ?? ""),
    track: String(c.track ?? ""),
  }));
  const armB = topByAffinity(
    (sheet.cues ?? []).map((c: any) => ({
      artist: String(c.artist ?? ""),
      track: String(c.track ?? ""),
      affinity: typeof c.affinity === "number" ? c.affinity : 0,
    })),
    K,
  ).map((c: any) => ({ artist: c.artist, track: c.track }));

  const byArm: Record<"A" | "B", Array<{ artist: string; track: string }>> = { A: armA, B: armB };

  lines.push(`## ${briefId}`, "");
  lines.push(`> ${evidence.scene}`, "");

  for (const label of ["X", "Y"] as const) {
    lines.push(`**Answer ${label}**`, "");
    for (const item of byArm[labels[label]]) {
      lines.push(`- ${item.artist} — ${item.track}`);
    }
    lines.push("");
    lines.push(`ratings: relevance __  variety __  wouldUse __`);
    lines.push("");
  }
}

writeFileSync(resolve(reviewDir, "worksheet.md"), `${lines.join("\n")}\n`, "utf8");

// The mapping is written separately so it can be kept out of the reviewer's
// view. Unblinding is a deliberate step, not something the worksheet leaks.
writeFileSync(
  resolve(reviewDir, "mapping.json"),
  `${JSON.stringify(
    {
      mappingVersion: "1.0.0",
      protocolHash,
      note: "X/Y to arm mapping. Do not open this until the review is submitted.",
      mapping,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Wrote benchmark/reviews/worksheet.md (${files.length} briefs, ${K} items per answer)`);
console.log("Wrote benchmark/reviews/mapping.json — keep this from the reviewer until ratings are in.");
