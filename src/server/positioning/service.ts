/**
 * DGNSS report service for the web app: the systems configuration, SBS
 * uploads with an immediate preview, a combined preview when Gator split the
 * export into several files, one-at-a-time report generation in the
 * background, and stored reports (PDF, HTML, evidence package) for download.
 *
 * Storage: <data root>/dgnss-reports/{uploads,reports}/<id>/. Uploads are
 * dropped after a day; reports follow the evidence retention period.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { ZipArchive } from "archiver";
import type { DataDomain } from "../../shared/types";
import {
  defaultDgnssConfig,
  validateDgnssConfig,
  DGNSS_MAX_FILES,
  DGNSS_MAX_SET_SPAN_MS,
  type DgnssConfig,
  type DgnssConfigResponse,
  type DgnssReportSummary,
  type DgnssSbsFile,
  type DgnssSetPreview,
  type DgnssUploadPreview,
  type DgnssWindowRequest,
} from "../../shared/dgnss";
import { resolveWindow, utcDays } from "./analysis";
import { listOverlappingSessions, sessionCoverage } from "./evidenceSource";
import { buildDgnssReport, reportWindow, spanFitsDay } from "./pipeline";
import { parseSbsFiles, SbsParseError, scanSbsFile, type SbsSummary } from "./sbs";
import type { DgnssWorkerInput, DgnssWorkerMessage } from "./workerProtocol";
import type { PositioningReportIdentity, ReportWindow } from "./types";

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Report process heap cap: a report that needs more fails on its own and never pressures live monitoring. */
const WORKER_HEAP_MB = 192;
const CANCEL_GRACE_MS = 10_000;
const MAX_SBS_TEXT_BYTES = 64 * 1024 * 1024;
/** Decompressed SBS text one report may combine. */
const MAX_SET_TEXT_BYTES = 256 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTS = 200;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
/** CSV data written next to the report and packaged under data/. */
const DATA_FILES = ["dgps-statistics.csv", "events.csv", "rf-coverage.csv", "sbs-files.csv"];

export class DgnssUserError extends Error {
  constructor(message: string, readonly status = 422, readonly fields?: Record<string, string>) {
    super(message);
  }
}

interface StoredUpload {
  preview: DgnssUploadPreview;
  /** Light scan with per-page spans (absent on uploads made before multi-file support). */
  scan?: SbsSummary;
  createdAt: string;
}

/** Uploaded files checked together; the arithmetic behind the set preview and generation. */
interface UploadSet {
  files: DgnssSbsFile[];
  scans: SbsSummary[];
  startMs: number;
  endMs: number;
  intervalMs: number;
  intervals: number[];
  lineNames: string[];
  systemsFound: string[];
  gaps: Array<[number, number]>;
  overlaps: Array<[number, number]>;
  duplicates: string[];
}

interface Job {
  summary: DgnssReportSummary;
  /** Input files in time order. */
  files: DgnssSbsFile[];
  window: DgnssWindowRequest;
  resolvedWindow: ReportWindow;
  cancelled: boolean;
  worker?: ChildProcess;
}

interface BuildOutcome {
  status: DgnssReportSummary["status"];
  verdict: string;
  facts: NonNullable<DgnssReportSummary["facts"]>;
  windowStartMs: number;
  rfSource?: string;
}

export interface DgnssServiceOptions {
  root: string;
  configPath: string;
  evidenceRoot: string;
  dataDomain: DataDomain;
  retentionMs: number;
  /** Report header from Site settings. */
  identity: () => PositioningReportIdentity;
  /** Capture target labels from the band catalog. */
  targetLabel: (targetId: string) => string;
  /** False while the host is under resource pressure; generation waits. */
  canStart: () => boolean;
  audit: (action: string, reason: string, clientAddress: string) => Promise<void>;
  /** Report process script (forked); without it reports build in-process (tests). */
  workerUrl?: URL;
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "report";
}

/** "2026-11-10 11:12" (UTC). */
function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function utcSpan(fromMs: number, toMs: number): string {
  const from = utcMinute(fromMs);
  const to = utcMinute(toMs);
  return `${from}–${from.slice(0, 10) === to.slice(0, 10) ? to.slice(11) : to} UTC`;
}

/** Union of spans, in time order. */
function unionSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const span of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function previewScan(preview: DgnssUploadPreview): SbsSummary {
  return {
    lineName: preview.lineName,
    systems: preview.systemsFound.map((id) => ({ id, shots: preview.shotCount, startMs: preview.startMs, endMs: preview.endMs })),
    startMs: preview.startMs,
    endMs: preview.endMs,
    intervalMs: preview.intervalMs,
    shotCount: preview.shotCount,
  };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  await rename(temp, file);
}

export class DgnssReportService {
  private config: DgnssConfig = defaultDgnssConfig();
  private configured = false;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private running = false;
  private waitTimer?: NodeJS.Timeout;

  private constructor(private readonly options: DgnssServiceOptions) {}

  static async open(options: DgnssServiceOptions): Promise<DgnssReportService> {
    const service = new DgnssReportService(options);
    await mkdir(service.uploadsDir, { recursive: true, mode: 0o750 });
    await mkdir(service.reportsDir, { recursive: true, mode: 0o750 });
    try {
      const saved = JSON.parse(await readFile(options.configPath, "utf8")) as DgnssConfig;
      const checked = validateDgnssConfig(saved);
      if (checked.config) {
        service.config = { schemaVersion: 1, revision: Number(saved.revision) || 1, updatedAt: saved.updatedAt, ...checked.config };
        service.configured = true;
      }
    } catch {
      // Not configured yet.
    }
    await service.recoverInterrupted();
    await service.prune();
    return service;
  }

  private get uploadsDir(): string {
    return path.join(this.options.root, "uploads");
  }

  private get reportsDir(): string {
    return path.join(this.options.root, "reports");
  }

  // ---- configuration --------------------------------------------------------

  configResponse(unlocked: boolean): DgnssConfigResponse {
    return { config: this.config, configured: this.configured, admin: { unlocked } };
  }

  async saveConfig(input: unknown, expectedRevision: unknown, clientAddress: string): Promise<DgnssConfig> {
    if (Number(expectedRevision) !== this.config.revision) throw new DgnssUserError("Settings changed elsewhere. Reload and try again.", 409);
    const checked = validateDgnssConfig(input);
    if (!checked.config) throw new DgnssUserError("Check the highlighted fields", 422, checked.fields);
    const next: DgnssConfig = { schemaVersion: 1, revision: this.config.revision + 1, updatedAt: new Date().toISOString(), ...checked.config };
    await mkdir(path.dirname(this.options.configPath), { recursive: true });
    await writeJsonAtomic(this.options.configPath, next);
    this.config = next;
    this.configured = true;
    await this.options.audit("dgnss-report-configuration-saved", `revision ${next.revision}: ${next.systems.length} systems, control ${next.controlId}, threshold ${next.agreementM} m`, clientAddress);
    return next;
  }

  // ---- uploads ----------------------------------------------------------------

  /**
   * Accepts the browser's upload (plain or gzip), streams it to disk while
   * hashing, checks it with a light scan and returns the preview. The full
   * parse happens later, in the report worker.
   */
  async upload(body: Buffer, fileName: string): Promise<DgnssUploadPreview> {
    if (!body.length) throw new DgnssUserError("The file is empty");
    const uploadId = newId();
    const dir = path.join(this.uploadsDir, uploadId);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const sbsPath = path.join(dir, "input.sbs");
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_SBS_TEXT_BYTES) callback(new DgnssUserError("The file is too large (over 64 MB of SBS text). Export it from Gator in parts."));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    const gzipped = body[0] === 0x1f && body[1] === 0x8b;
    let summary: SbsSummary;
    try {
      if (gzipped) await pipeline(Readable.from([body]), createGunzip(), meter, createWriteStream(sbsPath, { mode: 0o640 }));
      else await pipeline(Readable.from([body]), meter, createWriteStream(sbsPath, { mode: 0o640 }));
      summary = await scanSbsFile(sbsPath);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (error instanceof DgnssUserError) throw error;
      if (error instanceof SbsParseError) throw new DgnssUserError(`Not a Gator SBS export: ${error.message}. Export the DGPS QC pages from Gator as SBS.`);
      if (gzipped) throw new DgnssUserError("The file could not be read. Try again.");
      throw new DgnssUserError("Not a Gator SBS export: it could not be read. Export the DGPS QC pages from Gator as SBS.");
    }
    if (summary.endMs - summary.startMs > DGNSS_MAX_SET_SPAN_MS) {
      await rm(dir, { recursive: true, force: true });
      throw new DgnssUserError("The file covers more than 7 days. Export a shorter period from Gator.");
    }
    const sha256 = hash.digest("hex");
    const dataset = summary;
    const cleanName = path.basename(fileName || "upload.sbs").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "upload.sbs";
    const sbsWindow = resolveWindow(dataset, "sbs");
    const dayWindow = resolveWindow(dataset, "utc-day");
    const sessions = await listOverlappingSessions(this.options.evidenceRoot, sbsWindow, this.options.dataDomain);
    const coverage = sessionCoverage(sessions, sbsWindow);
    const configuredIds = this.config.systems.map((system) => system.id);
    const foundIds = [...new Set(dataset.systems.map((system) => system.id))];
    const missingSystems = configuredIds.filter((id) => !foundIds.includes(id));
    const unknownSystems = foundIds.filter((id) => !configuredIds.includes(id));
    const warnings: string[] = [];
    if (!this.configured) warnings.push("DGNSS systems are not set up yet. Ask an administrator to save them in Settings › Site › DGNSS report.");
    else if (!foundIds.some((id) => configuredIds.includes(id))) warnings.push("None of the configured DGNSS systems is in this file.");
    if (missingSystems.length && this.configured) warnings.push(`Not in this file: ${missingSystems.join(", ")}.`);
    if (unknownSystems.length && this.configured) warnings.push(`Not configured, left out: ${unknownSystems.join(", ")}.`);
    if (coverage.fraction === 0) warnings.push("rf-monitor did not record during this file. The report will cover positioning only.");
    else if (coverage.fraction < 0.95) warnings.push(`rf-monitor recorded ${Math.round(coverage.fraction * 100)}% of this file's time span.`);
    const preview: DgnssUploadPreview = {
      uploadId,
      fileName: cleanName,
      bytes: size,
      sha256,
      lineName: dataset.lineName,
      startMs: dataset.startMs,
      endMs: dataset.endMs,
      shotCount: dataset.shotCount,
      intervalMs: dataset.intervalMs,
      systemsFound: foundIds,
      missingSystems,
      unknownSystems,
      windows: { sbs: [sbsWindow.startMs, sbsWindow.endMs], utcDay: [dayWindow.startMs, dayWindow.endMs] },
      rf: { sessionCoverage: coverage.fraction, sessions: sessions.length, targets: coverage.targets.map((id) => ({ id, label: this.options.targetLabel(id) })) },
      warnings,
    };
    await writeJsonAtomic(path.join(dir, "upload.json"), { preview, scan: summary, createdAt: new Date().toISOString() } satisfies StoredUpload);
    void this.pruneUploads();
    return preview;
  }

  // ---- sets of files -----------------------------------------------------------

  /** Loads uploaded files (in time order) and works out their combined span, gaps and overlaps. */
  private async loadSet(uploadIds: unknown): Promise<UploadSet> {
    if (!Array.isArray(uploadIds) || !uploadIds.length) throw new DgnssUserError("Upload at least one SBS file");
    if (uploadIds.length > DGNSS_MAX_FILES) throw new DgnssUserError(`Up to ${DGNSS_MAX_FILES} SBS files in one report`);
    const ids = [...new Set(uploadIds)];
    if (ids.some((id) => typeof id !== "string" || !ID.test(id))) throw new DgnssUserError("Upload the SBS files again", 404);
    const loaded: Array<{ file: DgnssSbsFile; scan: SbsSummary; order: number }> = [];
    for (const [order, id] of (ids as string[]).entries()) {
      let stored: StoredUpload;
      try {
        stored = JSON.parse(await readFile(path.join(this.uploadsDir, id, "upload.json"), "utf8")) as StoredUpload;
      } catch {
        throw new DgnssUserError("An upload has expired. Upload the SBS files again.", 404);
      }
      const { preview } = stored;
      loaded.push({
        order,
        scan: stored.scan ?? previewScan(preview),
        file: { uploadId: id, fileName: preview.fileName, bytes: preview.bytes, sha256: preview.sha256, lineName: preview.lineName, startMs: preview.startMs, endMs: preview.endMs, shotCount: preview.shotCount, intervalMs: preview.intervalMs, systemsFound: preview.systemsFound },
      });
    }
    loaded.sort((left, right) => left.file.startMs - right.file.startMs || left.order - right.order);
    // The same file twice adds nothing: keep the first copy.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    const unique = loaded.filter(({ file }) => {
      const first = seen.get(file.sha256);
      if (first !== undefined) {
        duplicates.push(file.fileName === first ? file.fileName : `${file.fileName} (same as ${first})`);
        return false;
      }
      seen.set(file.sha256, file.fileName);
      return true;
    });
    const files = unique.map((entry) => entry.file);
    const scans = unique.map((entry) => entry.scan);
    if (files.reduce((sum, file) => sum + file.bytes, 0) > MAX_SET_TEXT_BYTES) throw new DgnssUserError("These files are too large together (over 256 MB of SBS text). Make the report from fewer files.", 413);
    const startMs = Math.min(...files.map((file) => file.startMs));
    const endMs = Math.max(...files.map((file) => file.endMs));
    if (endMs - startMs > DGNSS_MAX_SET_SPAN_MS) throw new DgnssUserError("These files cover more than 7 days. Remove files outside the period you need.");
    const weights = new Map<number, number>();
    for (const file of files) weights.set(file.intervalMs, (weights.get(file.intervalMs) ?? 0) + file.shotCount);
    const intervalMs = [...weights.entries()].sort((left, right) => right[1] - left[1])[0][0];

    const bySystem = new Map<string, Array<[number, number]>>();
    for (const scan of scans) {
      for (const system of scan.systems) {
        const spans = bySystem.get(system.id) ?? [];
        spans.push([system.startMs, system.endMs]);
        bySystem.set(system.id, spans);
      }
    }
    // A page repeated within one file is one system; overlaps are between files.
    const overlapSpans: Array<[number, number]> = [];
    for (const [id] of bySystem) {
      const perFile = scans
        .map((scan) => scan.systems.filter((system) => system.id === id))
        .filter((list) => list.length)
        .map((list) => [Math.min(...list.map((system) => system.startMs)), Math.max(...list.map((system) => system.endMs))] as [number, number])
        .sort((left, right) => left[0] - right[0]);
      let reach = Number.NEGATIVE_INFINITY;
      for (const [from, to] of perFile) {
        if (from <= reach) overlapSpans.push([from, Math.min(reach, to) + intervalMs]);
        reach = Math.max(reach, to);
      }
    }
    const covered = unionSpans(files.map((file) => [file.startMs, file.endMs + file.intervalMs]));
    const gaps: Array<[number, number]> = [];
    for (let index = 1; index < covered.length; index += 1) {
      if (covered[index][0] - covered[index - 1][1] > intervalMs * 2) gaps.push([covered[index - 1][1], covered[index][0]]);
    }
    const lineNames = [...new Set(files.map((file) => file.lineName).filter(Boolean))];
    return {
      files,
      scans,
      startMs,
      endMs,
      intervalMs,
      intervals: [...weights.keys()].sort((left, right) => left - right),
      lineNames,
      systemsFound: [...bySystem.keys()],
      gaps,
      overlaps: unionSpans(overlapSpans),
      duplicates,
    };
  }

  /** Combined check of several uploaded SBS files, shown before the report is generated. */
  async previewSet(uploadIds: unknown): Promise<DgnssSetPreview> {
    const set = await this.loadSet(uploadIds);
    const span = { startMs: set.startMs, endMs: set.endMs, intervalMs: set.intervalMs };
    const fits = spanFitsDay(span);
    const sbsWindow = resolveWindow(span, "sbs");
    const dayWindow = resolveWindow(span, "utc-day");
    const sessions = await listOverlappingSessions(this.options.evidenceRoot, sbsWindow, this.options.dataDomain);
    const coverage = sessionCoverage(sessions, sbsWindow);
    const configuredIds = this.config.systems.map((system) => system.id);
    const missingSystems = configuredIds.filter((id) => !set.systemsFound.includes(id));
    const unknownSystems = set.systemsFound.filter((id) => !configuredIds.includes(id));
    const several = set.files.length > 1;
    const these = several ? "these files" : "this file";
    const list = (spans: Array<[number, number]>) => (spans.length <= 3 ? spans.map(([from, to]) => utcSpan(from, to)).join("; ") : `${spans.length} periods, first ${utcSpan(spans[0][0], spans[0][1])}`);
    const warnings: string[] = [];
    if (!this.configured) warnings.push("DGNSS systems are not set up yet. Ask an administrator to save them in Settings › Site › DGNSS report.");
    else if (!set.systemsFound.some((id) => configuredIds.includes(id))) warnings.push(`None of the configured DGNSS systems is in ${these}.`);
    if (missingSystems.length && this.configured) warnings.push(`Not in ${these}: ${missingSystems.join(", ")}.`);
    if (unknownSystems.length && this.configured) warnings.push(`Not configured, left out: ${unknownSystems.join(", ")}.`);
    if (set.duplicates.length) warnings.push(`Same file added twice, used once: ${set.duplicates.join(", ")}.`);
    if (set.lineNames.length > 1) warnings.push(`Different Gator lines: ${set.lineNames.join(", ")}.`);
    if (set.intervals.length > 1) warnings.push(`Different shot intervals: ${set.intervals.map((value) => `${value / 1000} s`).join(", ")}.`);
    if (set.gaps.length) warnings.push(`No Gator data ${list(set.gaps)}.`);
    if (set.overlaps.length) warnings.push(`Files overlap ${list(set.overlaps)}; repeated shots are counted once.`);
    if (!fits) warnings.push(`${several ? "These files cover" : "This file covers"} ${Math.round((set.endMs - set.startMs) / 3_600_000)} h. Choose a UTC day or a custom window (up to 24 h).`);
    if (coverage.fraction === 0) warnings.push(`rf-monitor did not record during ${these}. The report will cover positioning only.`);
    else if (coverage.fraction < 0.95) warnings.push(`rf-monitor recorded ${Math.round(coverage.fraction * 100)}% of ${several ? "this" : "this file's"} time span.`);
    return {
      uploadIds: set.files.map((file) => file.uploadId),
      files: set.files,
      bytes: set.files.reduce((sum, file) => sum + file.bytes, 0),
      lineName: set.lineNames.join(", "),
      lineNames: set.lineNames,
      startMs: set.startMs,
      endMs: set.endMs,
      intervalMs: set.intervalMs,
      shotCount: set.files.reduce((sum, file) => sum + file.shotCount, 0),
      systemsFound: set.systemsFound,
      missingSystems,
      unknownSystems,
      days: utcDays(set.startMs, set.endMs),
      spanFitsDay: fits,
      gaps: set.gaps,
      overlaps: set.overlaps,
      windows: { sbs: [sbsWindow.startMs, sbsWindow.endMs], utcDay: [dayWindow.startMs, dayWindow.endMs] },
      rf: { sessionCoverage: coverage.fraction, sessions: sessions.length, targets: coverage.targets.map((id) => ({ id, label: this.options.targetLabel(id) })) },
      warnings,
    };
  }

  // ---- reports ----------------------------------------------------------------

  /** Queues a report over one or more uploaded SBS files. */
  async generate(uploadIds: unknown, window: unknown): Promise<DgnssReportSummary> {
    if (!this.configured) throw new DgnssUserError("DGNSS systems are not set up. Ask an administrator to save them in Settings.", 409);
    const request = window as DgnssWindowRequest;
    if (!request || !["sbs", "utc-day", "custom"].includes(request.mode)) throw new DgnssUserError("Choose a report window");
    const set = await this.loadSet(typeof uploadIds === "string" ? [uploadIds] : uploadIds);
    // Check the window now so the operator sees a mistake immediately.
    let resolved: ReportWindow;
    try {
      resolved = reportWindow({ startMs: set.startMs, endMs: set.endMs, intervalMs: set.intervalMs }, request);
    } catch (error) {
      throw new DgnssUserError(error instanceof Error ? error.message : "Window is invalid");
    }
    if (this.queue.length >= 5) throw new DgnssUserError("Several reports are already waiting. Try again in a few minutes.", 503);
    const id = newId();
    const single = set.files.length === 1;
    const summary: DgnssReportSummary = {
      id,
      state: "queued",
      stage: "Waiting",
      progress: 0,
      createdAt: new Date().toISOString(),
      fileName: single ? set.files[0].fileName : `${set.files.length} SBS files`,
      lineName: set.lineNames.join(", ") || "–",
      sbsSha256: single ? set.files[0].sha256 : createHash("sha256").update(set.files.map((file) => file.sha256).sort().join("\n")).digest("hex"),
      sbsFiles: set.files.map((file) => ({ name: file.fileName, sha256: file.sha256, bytes: file.bytes })),
      window: { mode: request.mode, startMs: resolved.startMs, endMs: resolved.endMs },
    };
    const dir = path.join(this.reportsDir, id);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await writeJsonAtomic(path.join(dir, "report.json"), summary);
    this.jobs.set(id, { summary, files: set.files, window: request, resolvedWindow: resolved, cancelled: false });
    this.queue.push(id);
    void this.pump();
    return summary;
  }

  cancel(id: string): DgnssReportSummary | undefined {
    const job = this.jobs.get(id);
    if (!job || (job.summary.state !== "queued" && job.summary.state !== "running")) return job?.summary;
    job.cancelled = true;
    if (job.worker?.connected) {
      job.worker.send({ type: "cancel" });
      const child = job.worker;
      setTimeout(() => child.exitCode === null && child.kill(), CANCEL_GRACE_MS).unref();
    }
    if (job.summary.state === "queued") {
      this.queue.splice(this.queue.indexOf(id), 1);
      void this.finishJob(job, { state: "cancelled", stage: "Cancelled" });
    }
    return job.summary;
  }

  async list(limit = 50): Promise<DgnssReportSummary[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.reportsDir)).filter((name) => ID.test(name)).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    const reports: DgnssReportSummary[] = [];
    for (const name of names) {
      const live = this.jobs.get(name);
      if (live) {
        reports.push(live.summary);
        continue;
      }
      try {
        reports.push(JSON.parse(await readFile(path.join(this.reportsDir, name, "report.json"), "utf8")) as DgnssReportSummary);
      } catch {
        // Skip unreadable entries.
      }
    }
    return reports;
  }

  async get(id: string): Promise<DgnssReportSummary | undefined> {
    if (!ID.test(id)) return undefined;
    const live = this.jobs.get(id);
    if (live) return live.summary;
    try {
      return JSON.parse(await readFile(path.join(this.reportsDir, id, "report.json"), "utf8")) as DgnssReportSummary;
    } catch {
      return undefined;
    }
  }

  /** Absolute path and download name of a finished report file. */
  async file(id: string, kind: "pdf" | "html" | "package"): Promise<{ path: string; name: string; type: string } | undefined> {
    const summary = await this.get(id);
    if (!summary || summary.state !== "ready" || !summary.files) return undefined;
    const name = summary.files[kind];
    const file = path.join(this.reportsDir, id, kind === "pdf" ? "report.pdf" : kind === "html" ? "report.html" : "package.zip");
    try {
      await stat(file);
    } catch {
      return undefined;
    }
    return { path: file, name, type: kind === "pdf" ? "application/pdf" : kind === "html" ? "text/html; charset=utf-8" : "application/zip" };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const nextId = this.queue[0];
    if (!nextId) return;
    if (!this.options.canStart()) {
      this.waitTimer ??= setTimeout(() => {
        this.waitTimer = undefined;
        void this.pump();
      }, 5_000);
      const job = this.jobs.get(nextId);
      if (job) job.summary.stage = "Waiting for the system to be less busy";
      return;
    }
    this.queue.shift();
    const job = this.jobs.get(nextId);
    if (!job) return void this.pump();
    this.running = true;
    try {
      await this.run(job);
    } finally {
      this.running = false;
      void this.pump();
    }
  }

  private async run(job: Job): Promise<void> {
    const { summary } = job;
    const dir = path.join(this.reportsDir, summary.id);
    summary.state = "running";
    const stage = (name: string, progress: number) => {
      summary.stage = name;
      summary.progress = Math.max(summary.progress ?? 0, Math.min(0.99, progress));
    };
    try {
      stage("Reading SBS", 0.03);
      const sbsPaths = job.files.map((file) => path.join(this.uploadsDir, file.uploadId, "input.sbs"));
      const files: Array<{ name: string; bytes: number; sha256: string }> = [];
      for (const [index, file] of job.files.entries()) {
        try {
          files.push({ name: file.fileName, bytes: (await stat(sbsPaths[index])).size, sha256: file.sha256 });
        } catch {
          throw new DgnssUserError("An SBS upload expired before the report started. Upload the files again.");
        }
      }
      const workerInput: DgnssWorkerInput = {
        sbsPaths,
        outDir: dir,
        files,
        config: this.config,
        identity: { ...this.options.identity(), ...(this.config.survey ? { survey: this.config.survey } : {}), harbour: this.config.location, geodetics: this.config.geodetics },
        window: job.window,
        resolvedWindow: job.resolvedWindow,
        evidenceRoot: this.options.evidenceRoot,
        dataDomain: this.options.dataDomain,
      };
      const result = this.options.workerUrl ? await this.buildInWorker(job, workerInput, stage) : await this.buildInline(job, workerInput, stage);
      stage("Packaging", 0.95);
      const lineNames = [...new Set(job.files.map((file) => file.lineName).filter(Boolean))];
      const lineStem = `${safeName(lineNames[0] ?? "line")}${lineNames.length > 1 ? `+${lineNames.length - 1}` : ""}`;
      const stem = `DGNSS_Report_${lineStem}_${new Date(result.windowStartMs).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}_${summary.window.mode}`;
      const outputs = { pdf: `${stem}.pdf`, html: `${stem}.html`, package: `${stem}_evidence.zip` };
      const single = job.files.length === 1;
      const sbsEntries = job.files.map((file, index) => ({
        source: sbsPaths[index],
        name: single ? `input/${file.fileName}` : `input/${String(index + 1).padStart(2, "0")}_${file.fileName}`,
      }));
      await this.writePackage(dir, outputs, sbsEntries, {
        manifestVersion: 2,
        report: { id: summary.id, generatedAt: new Date().toISOString(), status: result.status, verdict: result.verdict, window: summary.window, lineName: summary.lineName },
        sbs: job.files.map((file, index) => ({
          fileName: file.fileName,
          packagePath: sbsEntries[index].name,
          sha256: file.sha256,
          bytes: files[index].bytes,
          lineName: file.lineName,
          firstObs: new Date(file.startMs).toISOString(),
          lastObs: new Date(file.endMs).toISOString(),
        })),
        rfSource: result.rfSource,
      });
      await this.finishJob(job, { state: "ready", stage: "Ready", progress: 1, status: result.status, verdict: result.verdict, facts: result.facts, files: outputs });
    } catch (error) {
      const message = job.cancelled ? "Cancelled" : error instanceof RangeError || error instanceof DgnssUserError ? error.message : "The report could not be built. Try again, or contact support with the SBS file.";
      if (!job.cancelled && !(error instanceof RangeError) && !(error instanceof DgnssUserError)) console.error("DGNSS report failed", error);
      await this.finishJob(job, { state: job.cancelled ? "cancelled" : "failed", stage: job.cancelled ? "Cancelled" : "Failed", error: message });
    }
    await this.prune();
  }

  private async buildInline(job: Job, input: DgnssWorkerInput, stage: (name: string, progress: number) => void): Promise<BuildOutcome> {
    const dataset = await parseSbsFiles(input.sbsPaths, { fromMs: input.resolvedWindow.startMs, toMs: input.resolvedWindow.endMs });
    const result = await buildDgnssReport({ ...input, dataset, onStage: stage, isCancelled: () => job.cancelled });
    await writeFile(path.join(input.outDir, "report.pdf"), result.pdf, { mode: 0o640 });
    await writeFile(path.join(input.outDir, "report.html"), result.html, { mode: 0o640 });
    for (const file of result.model.dataFiles) await writeFile(path.join(input.outDir, file.name), file.content, { mode: 0o640 });
    return { status: result.status, verdict: result.verdict, facts: result.facts, windowStartMs: result.window.startMs, rfSource: result.model.tables.evidence.rows.find((row) => row[0] === "RF evidence source")?.[1] };
  }

  private buildInWorker(job: Job, input: DgnssWorkerInput, stage: (name: string, progress: number) => void): Promise<BuildOutcome> {
    return new Promise((resolve, reject) => {
      // A child process returns all of its memory when it exits; the monitoring process never grows.
      // A small young generation keeps the 24 h report near 220 MB RSS (measured) instead of about 330 MB.
      const execArgv = [...process.execArgv.filter((argument) => !/^--max-(old|semi)-space-size/.test(argument)), `--max-old-space-size=${WORKER_HEAP_MB}`, "--max-semi-space-size=2"];
      const child = fork(fileURLToPath(this.options.workerUrl!), [], { execArgv, serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
      job.worker = child;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        job.worker = undefined;
        action();
      };
      child.on("message", (message: DgnssWorkerMessage) => {
        if (message.type === "stage") stage(message.stage, message.progress);
        else if (message.type === "done") finish(() => {
          console.log(`DGNSS report ${job.summary.id} built: ${message.facts.pages} pages, report process heap peak ${message.peakHeapMb ?? "?"} MB`);
          resolve({ status: message.status, verdict: message.verdict, facts: message.facts, windowStartMs: message.windowStartMs, rfSource: message.rfSource });
        });
        else {
          if (!message.user) console.error("DGNSS report process failed", message.detail);
          finish(() => reject(message.user ? new DgnssUserError(message.message) : new Error(message.message)));
        }
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("exit", (code, signal) => finish(() => {
        if (job.cancelled) reject(new DgnssUserError("Cancelled"));
        // V8 aborts with SIGABRT / exit 134 when the heap cap is reached.
        else if (signal === "SIGABRT" || code === 134) reject(new DgnssUserError("This report needs more memory than allowed. Choose a shorter window."));
        else reject(new Error(`Report process stopped (${signal ?? code})`));
      }));
      child.send({ type: "start", input });
    });
  }

  private async finishJob(job: Job, changes: Partial<DgnssReportSummary>): Promise<void> {
    Object.assign(job.summary, changes, { finishedAt: new Date().toISOString() });
    await writeJsonAtomic(path.join(this.reportsDir, job.summary.id, "report.json"), job.summary).catch(() => undefined);
    this.jobs.delete(job.summary.id);
  }

  /** PDF + HTML + data CSVs + every SBS input + manifest + SHA256SUMS. The SBS files are read from the uploads, not copied. */
  private async writePackage(dir: string, files: { pdf: string; html: string; package: string }, sbs: Array<{ source: string; name: string }>, manifest: Record<string, unknown>): Promise<void> {
    const data = (await readdir(dir).catch(() => [] as string[])).filter((name) => DATA_FILES.includes(name)).sort();
    const entries: Array<[string, string]> = [
      [path.join(dir, "report.pdf"), files.pdf],
      [path.join(dir, "report.html"), files.html],
      ...data.map((name): [string, string] => [path.join(dir, name), `data/${name}`]),
      ...sbs.map((entry): [string, string] => [entry.source, entry.name]),
    ];
    const sums: string[] = [];
    for (const [source, name] of entries) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer);
      sums.push(`${hash.digest("hex")}  ${name}`);
    }
    const manifestText = `${JSON.stringify({ packageType: "dgnss-report", ...manifest, files: sums.map((line) => ({ sha256: line.slice(0, 64), name: line.slice(66) })) }, null, 2)}\n`;
    const partial = path.join(dir, `package.zip.partial-${process.pid}`);
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(partial, { flags: "w", mode: 0o640 });
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on("close", () => resolve());
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      for (const [source, name] of entries) archive.file(source, { name });
      archive.append(manifestText, { name: "manifest.json" });
      archive.append(`${sums.join("\n")}\n`, { name: "SHA256SUMS.txt" });
      void archive.finalize().catch(reject);
    });
    await rename(partial, path.join(dir, "package.zip"));
  }

  private async recoverInterrupted(): Promise<void> {
    for (const report of await this.list(MAX_REPORTS)) {
      if (report.state === "queued" || report.state === "running") {
        Object.assign(report, { state: "failed", stage: "Failed", error: "Interrupted by a restart. Generate it again.", finishedAt: new Date().toISOString() });
        await writeJsonAtomic(path.join(this.reportsDir, report.id, "report.json"), report).catch(() => undefined);
      }
    }
  }

  private async pruneUploads(): Promise<void> {
    // Files of a queued or running report stay until it has been packaged.
    const inUse = new Set([...this.jobs.values()].flatMap((job) => job.files.map((file) => file.uploadId)));
    try {
      for (const name of await readdir(this.uploadsDir)) {
        if (!ID.test(name) || inUse.has(name)) continue;
        const details = await stat(path.join(this.uploadsDir, name));
        if (Date.now() - details.mtimeMs > UPLOAD_TTL_MS) await rm(path.join(this.uploadsDir, name), { recursive: true, force: true });
      }
    } catch {
      // Best effort.
    }
  }

  /** Reports older than the evidence retention period, and beyond the newest 200, are removed. */
  async prune(): Promise<void> {
    await this.pruneUploads();
    try {
      const names = (await readdir(this.reportsDir)).filter((name) => ID.test(name)).sort().reverse();
      for (const [index, name] of names.entries()) {
        if (this.jobs.has(name)) continue;
        const details = await stat(path.join(this.reportsDir, name));
        if (index >= MAX_REPORTS || Date.now() - details.mtimeMs > this.options.retentionMs) await rm(path.join(this.reportsDir, name), { recursive: true, force: true });
      }
    } catch {
      // Best effort.
    }
  }
}
