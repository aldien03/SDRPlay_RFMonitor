/**
 * One DGNSS report from one or more Gator SBS files and rf-monitor evidence:
 * parse -> window -> stream RF evidence -> analyse -> model -> PDF + HTML.
 * Used by the web service and the command-line generator.
 */
import { PDFDocument } from "pdf-lib";
import type { DataDomain } from "../../shared/types";
import type { DgnssConfig, DgnssStatus, DgnssWindowRequest } from "../../shared/dgnss";
import { analysePositioning, resolveWindow } from "./analysis";
import { listOverlappingSessions, streamSessionFrames, type StreamOptions } from "./evidenceSource";
import { RfAccumulator, defaultRfLanes } from "./rfAnalysis";
import { buildPositioningReportModel, type PositioningReportModel } from "./reportModel";
import { renderPositioningReportHtml } from "./reportHtml";
import { renderPositioningReportPdf } from "./reportPdf";
import type { SbsDataset } from "./sbs";
import { DEFAULT_THRESHOLDS, type PositioningReportIdentity, type ReportWindow } from "./types";

export interface SbsFileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}

export interface PipelineInput {
  dataset: SbsDataset;
  /** Input files, in the order they were parsed (dataset.files has the same order). */
  files: SbsFileIdentity[];
  config: DgnssConfig;
  identity: PositioningReportIdentity;
  window: DgnssWindowRequest;
  /** Window already resolved (and used to filter the parse) by the caller. */
  resolvedWindow?: ReportWindow;
  evidenceRoot: string;
  dataDomain: DataDomain;
  generatedAt?: Date;
  /** Mock-up only: alter RF frames (time shift, simulated episode). */
  rfStream?: Pick<StreamOptions, "transform" | "offsetMs">;
  rfSessionPaths?: string[];
  rfSourceNote?: string;
  onStage?: (stage: string, progress: number) => void;
  isCancelled?: () => boolean;
}

export interface PipelineResult {
  model: PositioningReportModel;
  html: string;
  pdf: Uint8Array;
  window: ReportWindow;
  status: DgnssStatus;
  verdict: string;
  facts: { maxToControlM?: number; maxSystem?: string; controlId: string; rfEpisodes: number; interferenceEvents: number; events: number; pages: number; rfFrames: number };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when the SBS span itself can be the report window (at most 24 h). */
export function spanFitsDay(dataset: Pick<SbsDataset, "startMs" | "endMs">): boolean {
  return dataset.endMs - dataset.startMs <= 86_400_000;
}

export function reportWindow(dataset: Pick<SbsDataset, "startMs" | "endMs" | "intervalMs">, request: DgnssWindowRequest): ReportWindow {
  if (request.mode === "custom") {
    const startMs = Date.parse(request.start ?? "");
    const endMs = Date.parse(request.end ?? "");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new RangeError("Enter a custom start and end in UTC, end after start");
    if (endMs - startMs > 86_400_000) throw new RangeError("A custom window can be up to 24 h");
    if (endMs <= dataset.startMs || startMs > dataset.endMs) throw new RangeError("The custom window has no Gator data. Choose times inside the files.");
    return resolveWindow(dataset, "custom", { custom: { startMs, endMs } });
  }
  if (request.mode === "utc-day") {
    if (request.day !== undefined && (typeof request.day !== "string" || !DAY.test(request.day) || !Number.isFinite(Date.parse(`${request.day}T00:00:00Z`)))) throw new RangeError("Choose a UTC day");
    const window = resolveWindow(dataset, "utc-day", { day: request.day });
    if (window.endMs <= dataset.startMs || window.startMs > dataset.endMs) throw new RangeError("The files have no Gator data on that UTC day");
    return window;
  }
  if (!spanFitsDay(dataset)) throw new RangeError("The files cover more than 24 h. Choose a UTC day or a custom window.");
  return resolveWindow(dataset, "sbs");
}

export async function buildDgnssReport(input: PipelineInput): Promise<PipelineResult> {
  const stage = input.onStage ?? (() => undefined);
  const cancelled = () => input.isCancelled?.() === true;
  const { config } = input;
  // Released after the analysis so the parsed SBS is not held while the PDF is drawn.
  let dataset: SbsDataset | undefined = input.dataset;
  const window = input.resolvedWindow ?? reportWindow(dataset, input.window);
  const present = new Set(input.dataset.systems.map((entry) => entry.id));
  const systems = config.systems.filter((system) => present.has(system.id));
  if (!systems.length) throw new RangeError(input.files.length > 1 ? "None of the configured DGNSS systems is in these SBS files" : "None of the configured DGNSS systems is in this SBS file");
  const controlId = systems.some((system) => system.id === config.controlId) ? config.controlId : systems[0].id;

  stage("Reading RF evidence", 0.1);
  const lanes = defaultRfLanes(systems.map((system) => system.beam));
  const accumulator = new RfAccumulator(lanes, window);
  const sessions = input.rfSessionPaths
    ? input.rfSessionPaths.map((sessionPath) => ({ id: sessionPath.split("/").filter(Boolean).at(-1) ?? sessionPath, path: sessionPath }))
    : await listOverlappingSessions(input.evidenceRoot, window, input.dataDomain);
  let index = 0;
  for (const session of sessions) {
    if (cancelled()) throw new Error("Cancelled");
    await streamSessionFrames(session.path, window, accumulator, {
      ...input.rfStream,
      isCancelled: cancelled,
      onProgress: () => stage(`Reading RF evidence (${accumulator.frames.toLocaleString("en-GB")} frames)`, 0.1 + (0.6 * (index + 0.5)) / Math.max(1, sessions.length)),
    });
    index += 1;
    await yieldToEventLoop();
  }
  const simulated = Boolean(input.rfStream);
  const rf = accumulator.finish(simulated ? "simulated" : "rf-monitor");

  if (cancelled()) throw new Error("Cancelled");
  stage("Analysing interference and positioning", 0.75);
  await yieldToEventLoop();
  // Analysis and the parsed SBS stay inside this scope so they can be freed before PDF rendering.
  const { model, facts } = (() => {
  const analysis = analysePositioning({
    dataset: dataset!,
    systems,
    thresholds: { ...DEFAULT_THRESHOLDS, agreementM: config.agreementM, movingKnots: config.movingKnots },
    window,
    rf: rf.evidence,
    controlId,
  });
  const sourceText = input.rfSourceNote
    ?? (sessions.length
      ? `rf-monitor ${input.dataDomain} evidence: ${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.map((session) => session.id).join(", ")}), ${accumulator.frames.toLocaleString("en-GB")} frames`
      : "rf-monitor recorded no session in this window");
  const built = buildPositioningReportModel({ analysis, identity: input.identity, files: input.files, generatedAt: input.generatedAt ?? new Date(), rf: { lanes: rf.lanes, episodes: rf.episodes, sourceText } });
  const comparisons = analysis.systems.filter((system) => system.vsControl);
  const worst = comparisons.reduce<(typeof comparisons)[number] | undefined>((best, system) => (!best || (system.vsControl!.agreementMax > best.vsControl!.agreementMax) ? system : best), undefined);
  return {
    model: built,
    facts: {
      maxToControlM: worst?.vsControl?.agreementMax,
      maxSystem: worst?.id,
      controlId,
      rfEpisodes: rf.episodes.length,
      interferenceEvents: built.tables.rfEpisodes.rows.filter((row) => /degraded both/.test(row.at(-1) ?? "")).length,
      events: analysis.events.length,
      rfFrames: accumulator.frames,
    },
  };
  })();
  (input as { dataset?: unknown }).dataset = undefined;
  dataset = undefined;

  if (cancelled()) throw new Error("Cancelled");
  stage("Building PDF and HTML", 0.85);
  await yieldToEventLoop();
  const html = renderPositioningReportHtml(model);
  await yieldToEventLoop();
  const pdf = await renderPositioningReportPdf(model);
  const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();

  return {
    model,
    html,
    pdf,
    window,
    status: model.verdictStatus,
    verdict: model.verdict,
    facts: { ...facts, pages },
  };
}
