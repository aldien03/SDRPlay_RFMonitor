/**
 * DGNSS report service for the web app: the systems configuration, SBS
 * uploads with an immediate preview, one-at-a-time report generation in the
 * background, and stored reports (PDF, HTML, evidence package) for download.
 *
 * Storage: <data root>/dgnss-reports/{uploads,reports}/<id>/. Uploads are
 * dropped after a day; reports follow the evidence retention period.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  type DgnssConfig,
  type DgnssConfigResponse,
  type DgnssReportSummary,
  type DgnssUploadPreview,
  type DgnssWindowRequest,
} from "../../shared/dgnss";
import { resolveWindow } from "./analysis";
import { listOverlappingSessions, sessionCoverage } from "./evidenceSource";
import { buildDgnssReport, reportWindow } from "./pipeline";
import { parseSbsFile, SbsParseError, scanSbsFile, type SbsSummary } from "./sbs";
import type { DgnssWorkerInput, DgnssWorkerMessage } from "./workerProtocol";
import type { PositioningReportIdentity } from "./types";

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Report process heap cap: a report that needs more fails on its own and never pressures live monitoring. */
const WORKER_HEAP_MB = 192;
const CANCEL_GRACE_MS = 10_000;
const MAX_SBS_TEXT_BYTES = 64 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTS = 200;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

export class DgnssUserError extends Error {
  constructor(message: string, readonly status = 422, readonly fields?: Record<string, string>) {
    super(message);
  }
}

interface StoredUpload {
  preview: DgnssUploadPreview;
  createdAt: string;
}

interface Job {
  summary: DgnssReportSummary;
  uploadId: string;
  window: DgnssWindowRequest;
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
        if (size > MAX_SBS_TEXT_BYTES) callback(new DgnssUserError("The file is too large. Export up to 24 h from Gator."));
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
    if (summary.endMs - summary.startMs > 86_400_000 + summary.intervalMs) {
      await rm(dir, { recursive: true, force: true });
      throw new DgnssUserError("The file covers more than 24 h. Export up to 24 h from Gator.");
    }
    const sha256 = hash.digest("hex");
    const dataset = summary;
    const cleanName = path.basename(fileName || "upload.sbs").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "upload.sbs";
    const sbsWindow = resolveWindow(dataset, "sbs");
    const dayWindow = resolveWindow(dataset, "utc-day");
    const sessions = await listOverlappingSessions(this.options.evidenceRoot, sbsWindow, this.options.dataDomain);
    const coverage = sessionCoverage(sessions, sbsWindow);
    const configuredIds = this.config.systems.map((system) => system.id);
    const foundIds = dataset.systems.map((system) => system.id);
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
    await writeJsonAtomic(path.join(dir, "upload.json"), { preview, createdAt: new Date().toISOString() } satisfies StoredUpload);
    void this.pruneUploads();
    return preview;
  }

  // ---- reports ----------------------------------------------------------------

  async generate(uploadId: unknown, window: unknown): Promise<DgnssReportSummary> {
    if (typeof uploadId !== "string" || !ID.test(uploadId)) throw new DgnssUserError("Upload the SBS file again", 404);
    if (!this.configured) throw new DgnssUserError("DGNSS systems are not set up. Ask an administrator to save them in Settings.", 409);
    const request = window as DgnssWindowRequest;
    if (!request || !["sbs", "utc-day", "custom"].includes(request.mode)) throw new DgnssUserError("Choose a report window");
    let stored: StoredUpload;
    try {
      stored = JSON.parse(await readFile(path.join(this.uploadsDir, uploadId, "upload.json"), "utf8")) as StoredUpload;
    } catch {
      throw new DgnssUserError("This upload has expired. Upload the SBS file again.", 404);
    }
    // Check the window now so the operator sees a mistake immediately.
    let resolved;
    try {
      resolved = reportWindow({ startMs: stored.preview.startMs, endMs: stored.preview.endMs, intervalMs: stored.preview.intervalMs }, request);
    } catch (error) {
      throw new DgnssUserError(error instanceof Error ? error.message : "Window is invalid");
    }
    if (this.queue.length >= 5) throw new DgnssUserError("Several reports are already waiting. Try again in a few minutes.", 503);
    const id = newId();
    const summary: DgnssReportSummary = {
      id,
      state: "queued",
      stage: "Waiting",
      progress: 0,
      createdAt: new Date().toISOString(),
      fileName: stored.preview.fileName,
      lineName: stored.preview.lineName,
      sbsSha256: stored.preview.sha256,
      window: { mode: request.mode, startMs: resolved.startMs, endMs: resolved.endMs },
    };
    const dir = path.join(this.reportsDir, id);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await writeJsonAtomic(path.join(dir, "report.json"), summary);
    this.jobs.set(id, { summary, uploadId, window: request, cancelled: false });
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
      const sbsPath = path.join(this.uploadsDir, job.uploadId, "input.sbs");
      const sbsBytes = (await stat(sbsPath)).size;
      const workerInput: DgnssWorkerInput = {
        sbsPath,
        outDir: dir,
        file: { name: summary.fileName, bytes: sbsBytes, sha256: summary.sbsSha256 },
        config: this.config,
        identity: { ...this.options.identity(), ...(this.config.survey ? { survey: this.config.survey } : {}), harbour: this.config.location, geodetics: this.config.geodetics },
        window: job.window,
        evidenceRoot: this.options.evidenceRoot,
        dataDomain: this.options.dataDomain,
      };
      const result = this.options.workerUrl ? await this.buildInWorker(job, workerInput, stage) : await this.buildInline(job, workerInput, stage);
      stage("Packaging", 0.95);
      const stem = `DGNSS_Report_${safeName(summary.lineName)}_${new Date(result.windowStartMs).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}_${summary.window.mode}`;
      const files = { pdf: `${stem}.pdf`, html: `${stem}.html`, package: `${stem}_evidence.zip` };
      await copyFile(sbsPath, path.join(dir, "input.sbs"));
      await this.writePackage(dir, files, summary.fileName, {
        report: { id: summary.id, generatedAt: new Date().toISOString(), status: result.status, verdict: result.verdict, window: summary.window, lineName: summary.lineName },
        sbs: { fileName: summary.fileName, sha256: summary.sbsSha256, bytes: sbsBytes },
        rfSource: result.rfSource,
      });
      await this.finishJob(job, { state: "ready", stage: "Ready", progress: 1, status: result.status, verdict: result.verdict, facts: result.facts, files });
    } catch (error) {
      const message = job.cancelled ? "Cancelled" : error instanceof RangeError || error instanceof DgnssUserError ? error.message : "The report could not be built. Try again, or contact support with the SBS file.";
      if (!job.cancelled && !(error instanceof RangeError) && !(error instanceof DgnssUserError)) console.error("DGNSS report failed", error);
      await this.finishJob(job, { state: job.cancelled ? "cancelled" : "failed", stage: job.cancelled ? "Cancelled" : "Failed", error: message });
    }
    await this.prune();
  }

  private async buildInline(job: Job, input: DgnssWorkerInput, stage: (name: string, progress: number) => void): Promise<BuildOutcome> {
    const dataset = await parseSbsFile(input.sbsPath);
    const result = await buildDgnssReport({ ...input, dataset, onStage: stage, isCancelled: () => job.cancelled });
    await writeFile(path.join(input.outDir, "report.pdf"), result.pdf, { mode: 0o640 });
    await writeFile(path.join(input.outDir, "report.html"), result.html, { mode: 0o640 });
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

  private async writePackage(dir: string, files: { pdf: string; html: string; package: string }, sbsName: string, manifest: Record<string, unknown>): Promise<void> {
    const entries: Array<[string, string]> = [
      [path.join(dir, "report.pdf"), files.pdf],
      [path.join(dir, "report.html"), files.html],
      [path.join(dir, "input.sbs"), `input/${sbsName}`],
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
    try {
      for (const name of await readdir(this.uploadsDir)) {
        if (!ID.test(name)) continue;
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
