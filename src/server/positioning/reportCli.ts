/**
 * Command-line DGNSS report (same pipeline as the web app), for testing and
 * for the mock-up:
 *
 *   npx tsx src/server/positioning/reportCli.ts --sbs <file.sbs> [--sbs <more.sbs> ...] --config <dgnss.json> --out <dir>
 *     [--window sbs|utc-day|custom --day YYYY-MM-DD --start ISO --end ISO]
 *     [--evidence-root <dir> | --rf-session <session dir> [--rf-shift] [--simulate-wideband]]
 *
 * Several --sbs files are combined into one report (split Gator exports).
 * The config file is a DgnssConfig plus an "identity" block. --rf-shift and
 * --simulate-wideband mark the report as a mock-up.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { validateDgnssConfig, type DgnssConfig, type DgnssWindowMode } from "../../shared/dgnss";
import { buildDgnssReport } from "./pipeline";
import { simulatedWideband } from "./rfEvidence";
import { parseSbsFiles } from "./sbs";
import type { PositioningReportIdentity } from "./types";

const { values } = parseArgs({
  options: {
    sbs: { type: "string", multiple: true },
    day: { type: "string" },
    config: { type: "string" },
    out: { type: "string" },
    window: { type: "string", default: "sbs" },
    start: { type: "string" },
    end: { type: "string" },
    "evidence-root": { type: "string" },
    "rf-session": { type: "string" },
    "rf-shift": { type: "boolean", default: false },
    "simulate-wideband": { type: "boolean", default: false },
    "file-name": { type: "string" },
  },
});
if (!values.sbs?.length || !values.config || !values.out) {
  console.error("Usage: reportCli --sbs <file.sbs> [--sbs <more.sbs> ...] --config <dgnss.json> --out <dir> [--window sbs|utc-day|custom --start ISO --end ISO] [--evidence-root <dir> | --rf-session <dir> [--rf-shift] [--simulate-wideband]]");
  process.exit(2);
}

const sbsPaths = values.sbs;
const files: Array<{ name: string; bytes: number; sha256: string }> = [];
for (const [index, file] of sbsPaths.entries()) {
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  files.push({ name: index === 0 && values["file-name"] ? values["file-name"] : basename(file), bytes: (await stat(file)).size, sha256: hash });
}
const raw = JSON.parse(await readFile(values.config, "utf8")) as Record<string, unknown> & { identity?: PositioningReportIdentity };
const checked = validateDgnssConfig(raw);
if (!checked.config) {
  console.error("Config errors:", checked.fields);
  process.exit(2);
}
const config: DgnssConfig = { schemaVersion: 1, revision: 1, ...checked.config };
const dataset = await parseSbsFiles(sbsPaths);

let rfStream: Parameters<typeof buildDgnssReport>[0]["rfStream"];
let rfSourceNote: string | undefined;
let rfSessionPaths: string[] | undefined;
if (values["rf-session"]) {
  rfSessionPaths = [values["rf-session"]];
  const session = JSON.parse(await readFile(join(values["rf-session"], "session.json"), "utf8")) as { id: string; startedAt: string; endedAt?: string };
  const notes = [`rf-monitor session ${session.id}`];
  let offsetMs = 0;
  if (values["rf-shift"]) {
    offsetMs = Math.round((dataset.startMs - Date.parse(session.startedAt)) / 1000) * 1000;
    notes.push(`TIME-SHIFTED by ${(offsetMs / 3_600_000).toFixed(2)} h onto this Gator line (mock-up)`);
  }
  if (values["rf-shift"] || values["simulate-wideband"]) {
    const wideband = values["simulate-wideband"] ? simulatedWideband(["gnss-l1-e1-b1c-sbas", "gnss-glonass-g1"], dataset.startMs + 8 * 60_000 + 10_000, dataset.startMs + 10 * 60_000 + 40_000) : undefined;
    if (wideband) notes.push("SIMULATED wideband episode on L1 and G1 (mock-up)");
    rfStream = { offsetMs, transform: (frame) => (wideband ? wideband(frame) : frame) };
  }
  rfSourceNote = notes.join("; ");
}

const result = await buildDgnssReport({
  dataset,
  files,
  config,
  identity: raw.identity ?? { vesselName: "Vessel" },
  window: { mode: values.window as DgnssWindowMode, start: values.start, end: values.end, day: values.day },
  evidenceRoot: values["evidence-root"] ?? "/nonexistent",
  dataDomain: "field",
  rfStream,
  rfSessionPaths,
  rfSourceNote,
  onStage: (stage, progress) => process.stderr.write(`\r${Math.round(progress * 100)}% ${stage}`.padEnd(70)),
});
process.stderr.write("\n");
await mkdir(values.out, { recursive: true });
const stem = `DGNSS-verification-${(dataset.lineNames[0] ?? "line").replace(/[^A-Za-z0-9.-]+/g, "_")}-${values.window}`;
await writeFile(join(values.out, `${stem}.html`), result.html);
await writeFile(join(values.out, `${stem}.pdf`), result.pdf);
console.log(JSON.stringify({ out: join(values.out, stem), status: result.status, verdict: result.verdict, facts: result.facts }, null, 2));
