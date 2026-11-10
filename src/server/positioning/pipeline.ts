/**
 * One DGNSS report from a Gator SBS file and rf-monitor evidence:
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

export interface PipelineInput {
  dataset: SbsDataset;
  file: { name: string; bytes: number; sha256: string };
  config: DgnssConfig;
  identity: PositioningReportIdentity;
  window: DgnssWindowRequest;
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

export function reportWindow(dataset: Pick<SbsDataset, "startMs" | "endMs" | "intervalMs">, request: DgnssWindowRequest): ReportWindow {
  if (request.mode === "custom") {
    const startMs = Date.parse(request.start ?? "");
    const endMs = Date.parse(request.end ?? "");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new RangeError("Enter a custom start and end in UTC, end after start");
    if (endMs - startMs > 86_400_000) throw new RangeError("A custom window can be up to 24 h");
    return resolveWindow(dataset, "custom", { startMs, endMs });
  }
  return resolveWindow(dataset, request.mode === "utc-day" ? "utc-day" : "sbs");
}

export async function buildDgnssReport(input: PipelineInput): Promise<PipelineResult> {
  const stage = input.onStage ?? (() => undefined);
  const cancelled = () => input.isCancelled?.() === true;
  const { dataset, config } = input;
  const window = reportWindow(dataset, input.window);
  const systems = config.systems.filter((system) => dataset.systems.some((entry) => entry.id === system.id));
  if (!systems.length) throw new RangeError("None of the configured DGNSS systems is in this SBS file");
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
    dataset,
    systems: systems.map((system) => ({ ...system, ip: system.ip })),
    thresholds: { ...DEFAULT_THRESHOLDS, agreementM: config.agreementM, movingKnots: config.movingKnots },
    window,
    rf: rf.evidence,
    controlId,
  });
  const sourceText = input.rfSourceNote
    ?? (sessions.length
      ? `rf-monitor ${input.dataDomain} evidence: ${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.map((session) => session.id).join(", ")}), ${accumulator.frames.toLocaleString("en-GB")} frames`
      : "rf-monitor recorded no session in this window");
  const built = buildPositioningReportModel({ analysis, identity: input.identity, file: input.file, generatedAt: input.generatedAt ?? new Date(), rf: { lanes: rf.lanes, episodes: rf.episodes, sourceText } });
  const comparisons = analysis.systems.filter((system) => system.vsControl);
  const worst = comparisons.reduce<(typeof comparisons)[number] | undefined>((best, system) => (!best || (system.vsControl!.max > best.vsControl!.max) ? system : best), undefined);
  return {
    model: built,
    facts: {
      maxToControlM: worst?.vsControl?.max,
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
