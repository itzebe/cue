/**
 * Record live evidence for the LLM-only vs Qloo benchmark.
 *
 * This is the ONLY script in the benchmark that touches the network, and it is
 * never part of the test suite. It calls the deployed application once per
 * preregistered brief and writes the complete raw response to
 * `benchmark/evidence/<id>.json`, wrapped with the provenance needed to audit it:
 * the source commit, the protocol hash, the HTTP status and the latency.
 *
 * Both arms come from that one response. The production pipeline already builds
 * its own ungrounded control group (`CueSheet.baseline`), so the LLM-only arm is
 * not a reimplementation: it is the shipped code path, and its `source` field
 * says whether the model actually ran or a fixed sample was substituted.
 *
 * Run: npx tsx benchmark/record.mts [--url <endpoint>] [--only <briefId>]
 *
 * Credentials are never read, printed or written here. The deployment holds
 * them; this script sends only the scene text.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const url = flag("url", "https://cue-nine-iota.vercel.app/api/cue");
const only = flag("only", "");

const protocolPath = resolve(here, "protocol.json");
const protocolRaw = readFileSync(protocolPath);
const protocolHash = createHash("sha256").update(protocolRaw).digest("hex");
const protocol = JSON.parse(protocolRaw.toString("utf8"));

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
  .toString()
  .trim();

/**
 * Refuse to write evidence that appears to contain a credential. The deployment
 * does not echo keys, but this is the one place a mistake would commit one.
 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /gsk_[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_\-]{30,}/,
  /Bearer\s+[A-Za-z0-9._\-]{20,}/,
  /"(?:api[_-]?key|apikey|authorization|token)"\s*:\s*"[^"]{12,}"/i,
];

function assertNoSecret(text: string, label: string) {
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      throw new Error(
        `Refusing to write ${label}: response matches a credential pattern (${pattern}). ` +
          `Evidence must never contain key material.`,
      );
    }
  }
}

const evidenceDir = resolve(here, "evidence");
if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });

const briefs: Array<{ id: string; scene: string }> = protocol.briefs;
const targets = only ? briefs.filter((brief) => brief.id === only) : briefs;
if (targets.length === 0) {
  console.error(`No brief matches --only ${only}`);
  process.exit(1);
}

console.log(`Recording ${targets.length} brief(s) from ${url}`);
console.log(`Source commit: ${sourceCommit}`);
console.log(`Protocol hash: ${protocolHash}\n`);

let failures = 0;

for (const brief of targets) {
  const started = Date.now();
  let status = 0;
  let body = "";
  let transportError: string | null = null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: brief.scene }),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }

  const latencyMs = Date.now() - started;

  if (transportError || status !== 200) {
    // Do not write a partial file over existing good evidence.
    failures += 1;
    console.error(
      `FAIL ${brief.id}: ${transportError ?? `HTTP ${status}`} after ${latencyMs}ms — existing evidence left untouched`,
    );
    continue;
  }

  assertNoSecret(body, `${brief.id}.json`);

  let sheet: any;
  try {
    sheet = JSON.parse(body);
  } catch {
    failures += 1;
    console.error(`FAIL ${brief.id}: response was not JSON — existing evidence left untouched`);
    continue;
  }

  const envelope = {
    // Provenance. Everything a reader needs to audit this recording.
    evidenceVersion: "1.0.0",
    briefId: brief.id,
    scene: brief.scene,
    recordedAt: new Date().toISOString(),
    sourceUrl: url,
    sourceCommit,
    protocolVersion: protocol.protocolVersion,
    protocolHash,
    httpStatus: status,
    latencyMs,
    // The deployment's own report of what it ran, so provenance is not inferred.
    deployment: sheet.llm
      ? undefined
      : {
          mode: sheet.mode,
          sceneParse: sheet.sceneParse
            ? { source: sheet.sceneParse.source, provider: sheet.sceneParse.provider ?? null }
            : null,
          baselineSource: sheet.baseline?.source ?? null,
          qlooEndpoints: Array.isArray(sheet.receipts)
            ? [...new Set(sheet.receipts.map((r: any) => r.endpoint))]
            : [],
        },
    raw: sheet,
  };

  const path = resolve(evidenceDir, `${brief.id}.json`);
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  const baselineSource = sheet.baseline?.source ?? "missing";
  const nonOk = Array.isArray(sheet.receipts)
    ? sheet.receipts.filter((r: any) => r.status !== 200).length
    : 0;
  console.log(
    `OK   ${brief.id}: mode=${sheet.mode} armA.source=${baselineSource} ` +
      `armA.n=${sheet.baseline?.cues?.length ?? 0} armB.n=${sheet.cues?.length ?? 0} ` +
      `receipts=${sheet.receipts?.length ?? 0} nonOkReceipts=${nonOk} ${latencyMs}ms`,
  );

  // Be a polite client against a free hackathon endpoint.
  await new Promise((done) => setTimeout(done, 1500));
}

if (failures > 0) {
  console.error(`\n${failures} brief(s) failed to record. Existing evidence was preserved.`);
  process.exit(1);
}
console.log(`\nRecorded ${targets.length} brief(s) to benchmark/evidence/`);
