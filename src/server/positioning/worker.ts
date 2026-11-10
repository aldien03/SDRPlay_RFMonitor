/**
 * Builds one DGNSS report in a short-lived child process (forked by the
 * report service): its memory has its own heap cap and is returned to the
 * system when it exits, so reports never accumulate in the monitoring
 * process. Protocol over IPC: parent sends { type: "start", input } and may
 * send { type: "cancel" }; the child writes report.pdf/report.html into
 * outDir, replies with stage/done/error messages and exits.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { buildDgnssReport } from "./pipeline";
import { parseSbsFiles } from "./sbs";
import type { DgnssWorkerInput, DgnssWorkerMessage } from "./workerProtocol";

let cancelled = false;
let started = false;
let peakHeap = 0;
const sampleHeap = () => {
  peakHeap = Math.max(peakHeap, getHeapStatistics().used_heap_size);
};
const post = (message: DgnssWorkerMessage) => new Promise<void>((resolve) => {
  if (!process.send) return resolve();
  process.send(message, undefined, {}, () => resolve());
});

async function run(input: DgnssWorkerInput): Promise<void> {
  try {
    // The parsed SBS is handed straight to the pipeline (no local reference), which releases it before drawing the PDF.
    const result = await buildDgnssReport({
      dataset: await parseSbsFiles(input.sbsPaths, { fromMs: input.resolvedWindow.startMs, toMs: input.resolvedWindow.endMs }, (index) => {
        sampleHeap();
        void post({ type: "stage", stage: input.sbsPaths.length > 1 ? `Reading SBS file ${index + 1} of ${input.sbsPaths.length}` : "Reading SBS", progress: 0.03 + (0.06 * index) / input.sbsPaths.length });
      }),
      files: input.files,
      config: input.config,
      identity: input.identity,
      window: input.window,
      resolvedWindow: input.resolvedWindow,
      evidenceRoot: input.evidenceRoot,
      dataDomain: input.dataDomain,
      onStage: (stage, progress) => {
        sampleHeap();
        void post({ type: "stage", stage, progress });
      },
      isCancelled: () => cancelled,
    });
    sampleHeap();
    await writeFile(path.join(input.outDir, "report.pdf"), result.pdf, { mode: 0o640 });
    await writeFile(path.join(input.outDir, "report.html"), result.html, { mode: 0o640 });
    for (const file of result.model.dataFiles) await writeFile(path.join(input.outDir, file.name), file.content, { mode: 0o640 });
    await post({
      type: "done",
      status: result.status,
      verdict: result.verdict,
      facts: result.facts,
      windowStartMs: result.window.startMs,
      rfSource: result.model.tables.evidence.rows.find((row) => row[0] === "RF evidence source")?.[1],
      peakHeapMb: Math.round(peakHeap / 1048576),
    });
    process.exit(0);
  } catch (error) {
    await post({
      type: "error",
      message: cancelled ? "Cancelled" : error instanceof RangeError ? error.message : "The report could not be built. Try again, or contact support with the SBS file.",
      detail: error instanceof Error ? error.stack ?? error.message : String(error),
      user: error instanceof RangeError || cancelled,
    });
    process.exit(1);
  }
}

process.on("message", (message: { type?: string; input?: DgnssWorkerInput }) => {
  if (message?.type === "cancel") cancelled = true;
  else if (message?.type === "start" && message.input && !started) {
    started = true;
    void run(message.input);
  }
});
// The parent going away ends the job.
process.on("disconnect", () => process.exit(1));
