import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

export const MAX_QUEUED_EXPORT_JOBS = 2;
export const DEFAULT_COMPLETED_EXPORT_HISTORY = 32;
export const MAX_COMPLETED_EXPORT_HISTORY = 256;
export const DEFAULT_EXPORT_OUTPUT_LEASE_MS = 15 * 60_000;
export const DEFAULT_EXPORT_DOWNLOAD_LEASE_MS = 5 * 60_000;
export const MAX_EXPORT_DOWNLOAD_LEASE_MS = 15 * 60_000;

export type ExportJobState = "queued" | "running" | "ready" | "failed";

export interface ExportJobSnapshot {
  id: string;
  state: ExportJobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sizeBytes?: number;
  sha256?: string;
  parts?: ExportJobPartSnapshot[];
  error?: string;
}

export interface ExportJobPartSnapshot {
  number: number;
  sizeBytes: number;
  sha256: string;
}

export interface ExportJobBuilderContext {
  jobId: string;
}

export type ExportJobBuilder<Request> = (
  request: Request,
  context: ExportJobBuilderContext,
) => Promise<string | readonly string[]>;

export interface ExportJobQueueOptions<Request> {
  builder: ExportJobBuilder<Request>;
  completedHistoryLimit?: number;
  idFactory?: () => string;
  now?: () => Date;
  canStart?: () => boolean;
  retryDelayMs?: number;
  onOutputsReady?: (paths: readonly string[]) => void;
  onOutputsReleased?: (paths: readonly string[]) => void;
  onOutputsDiscarded?: (paths: readonly string[]) => void | Promise<void>;
  maxProtectedOutputBytes?: number | (() => number);
  outputLeaseMs?: number;
  downloadLeaseMs?: number;
}

export interface ExportSubmissionOptions {
  deduplicationKey?: string;
  estimatedOutputBytes?: number;
}

export interface ExportDownloadLease {
  readonly jobId: string;
  readonly outputPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly partNumber: number;
  readonly expiresAt: string;
  readonly signal: AbortSignal;
  release(): void;
}

export type ExportDownloadAcquireResult =
  | { acquired: true; lease: ExportDownloadLease }
  | { acquired: false; reason: "not-found" | "not-ready" | "busy" | "invalid-part" };

interface MutableExportJob<Request> extends ExportJobSnapshot {
  request?: Request;
  hasRequest: boolean;
  outputPaths?: string[];
  deduplicationKey?: string;
  reservedBytes: number;
  outputsProtected: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
  expiryPending?: boolean;
}

interface ActiveDownload {
  leaseId: string;
  jobId: string;
  abortController: AbortController;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export class ExportQueueFullError extends Error {
  readonly code = "EXPORT_QUEUE_FULL";

  constructor() {
    super(`Export queue is full: one build is active and ${MAX_QUEUED_EXPORT_JOBS} are already queued.`);
    this.name = "ExportQueueFullError";
  }
}

export class ExportProtectedBytesError extends Error {
  readonly code = "EXPORT_PROTECTED_BYTES_LIMIT";

  constructor(readonly limitBytes: number) {
    super(`Protected export capacity is exhausted at the ${limitBytes}-byte bound.`);
    this.name = "ExportProtectedBytesError";
  }
}

export async function sha256FileStreamed(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
  }

  return { sha256: hash.digest("hex"), sizeBytes };
}

export class ExportJobQueue<Request> {
  private readonly builder: ExportJobBuilder<Request>;
  private readonly completedHistoryLimit: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly canStart: () => boolean;
  private readonly retryDelayMs: number;
  private readonly onOutputsReady?: (paths: readonly string[]) => void;
  private readonly onOutputsReleased?: (paths: readonly string[]) => void;
  private readonly onOutputsDiscarded?: (paths: readonly string[]) => void | Promise<void>;
  private readonly maxProtectedOutputBytes?: () => number;
  private readonly outputLeaseMs: number;
  private readonly downloadLeaseMs: number;
  private readonly jobs = new Map<string, MutableExportJob<Request>>();
  private readonly jobsByDeduplicationKey = new Map<string, string>();
  private readonly queuedIds: string[] = [];
  private readonly completedIds: string[] = [];
  private activeJobId?: string;
  private activeDownload?: ActiveDownload;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly idleWaiters = new Set<() => void>();
  private reservedOutputBytes = 0;
  private protectedOutputBytes = 0;

  constructor(options: ExportJobQueueOptions<Request>) {
    if (!Number.isSafeInteger(options.completedHistoryLimit ?? DEFAULT_COMPLETED_EXPORT_HISTORY)) {
      throw new TypeError("completedHistoryLimit must be a positive safe integer.");
    }
    const historyLimit = options.completedHistoryLimit ?? DEFAULT_COMPLETED_EXPORT_HISTORY;
    if (historyLimit < 1 || historyLimit > MAX_COMPLETED_EXPORT_HISTORY) {
      throw new RangeError(`completedHistoryLimit must be between 1 and ${MAX_COMPLETED_EXPORT_HISTORY}.`);
    }

    this.builder = options.builder;
    this.completedHistoryLimit = historyLimit;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.canStart = options.canStart ?? (() => true);
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 10 || this.retryDelayMs > 60_000) {
      throw new RangeError("retryDelayMs must be between 10 and 60000 milliseconds.");
    }
    this.onOutputsReady = options.onOutputsReady;
    this.onOutputsReleased = options.onOutputsReleased;
    this.onOutputsDiscarded = options.onOutputsDiscarded;
    if (options.maxProtectedOutputBytes !== undefined) {
      const provider = typeof options.maxProtectedOutputBytes === "function"
        ? options.maxProtectedOutputBytes
        : () => options.maxProtectedOutputBytes as number;
      const initial = provider();
      if (!Number.isSafeInteger(initial) || initial < 1) throw new RangeError("maxProtectedOutputBytes must be a positive safe integer");
      this.maxProtectedOutputBytes = provider;
    }
    this.outputLeaseMs = options.outputLeaseMs ?? DEFAULT_EXPORT_OUTPUT_LEASE_MS;
    if (!Number.isSafeInteger(this.outputLeaseMs) || this.outputLeaseMs < 10 || this.outputLeaseMs > 24 * 60 * 60_000) {
      throw new RangeError("outputLeaseMs must be between 10 milliseconds and 24 hours");
    }
    this.downloadLeaseMs = options.downloadLeaseMs ?? DEFAULT_EXPORT_DOWNLOAD_LEASE_MS;
    if (!Number.isSafeInteger(this.downloadLeaseMs) || this.downloadLeaseMs < 10 || this.downloadLeaseMs > MAX_EXPORT_DOWNLOAD_LEASE_MS) {
      throw new RangeError(`downloadLeaseMs must be between 10 milliseconds and ${MAX_EXPORT_DOWNLOAD_LEASE_MS} milliseconds`);
    }
  }

  submit(request: Request, options: ExportSubmissionOptions = {}): ExportJobSnapshot {
    const deduplicationKey = options.deduplicationKey;
    if (deduplicationKey !== undefined) {
      if (!deduplicationKey || deduplicationKey.length > 512) throw new RangeError("deduplicationKey must contain 1 to 512 characters");
      const existingId = this.jobsByDeduplicationKey.get(deduplicationKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing && existing.state !== "failed") return snapshot(existing);
      if (existingId) this.jobsByDeduplicationKey.delete(deduplicationKey);
    }
    const reservedBytes = options.estimatedOutputBytes ?? 0;
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new RangeError("estimatedOutputBytes must be a non-negative safe integer");
    const protectedLimit = this.currentProtectedLimit();
    if (protectedLimit !== undefined && this.protectedOutputBytes + this.reservedOutputBytes + reservedBytes > protectedLimit) {
      throw new ExportProtectedBytesError(protectedLimit);
    }
    if (this.queuedIds.length >= MAX_QUEUED_EXPORT_JOBS) throw new ExportQueueFullError();

    const id = this.uniqueId();
    const job: MutableExportJob<Request> = {
      id,
      state: "queued",
      createdAt: this.timestamp(),
      request,
      hasRequest: true,
      ...(deduplicationKey ? { deduplicationKey } : {}),
      reservedBytes,
      outputsProtected: false,
    };
    this.jobs.set(id, job);
    if (deduplicationKey) this.jobsByDeduplicationKey.set(deduplicationKey, id);
    this.reservedOutputBytes += reservedBytes;
    this.queuedIds.push(id);
    this.startNext();
    return snapshot(job);
  }

  get(jobId: string): ExportJobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    return job ? snapshot(job) : undefined;
  }

  list(): ExportJobSnapshot[] {
    const orderedIds = [
      ...(this.activeJobId ? [this.activeJobId] : []),
      ...this.queuedIds,
      ...this.completedIds.slice().reverse(),
    ];
    return orderedIds.flatMap((id) => {
      const job = this.jobs.get(id);
      return job ? [snapshot(job)] : [];
    });
  }

  get activeBuildJobId(): string | undefined {
    return this.activeJobId;
  }

  get queuedCount(): number {
    return this.queuedIds.length;
  }

  get completedCount(): number {
    return this.completedIds.length;
  }

  get downloadActive(): boolean {
    return this.activeDownload !== undefined;
  }

  get protectedBytes(): number {
    return this.protectedOutputBytes;
  }

  tryAcquireDownload(jobId: string, partNumber = 1): ExportDownloadAcquireResult {
    const job = this.jobs.get(jobId);
    if (!job) return { acquired: false, reason: "not-found" };
    if (job.state !== "ready" || !job.outputPaths?.length || !job.parts?.length) {
      return { acquired: false, reason: "not-ready" };
    }
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > job.outputPaths.length) {
      return { acquired: false, reason: "invalid-part" };
    }
    if (this.activeDownload) return { acquired: false, reason: "busy" };

    const part = job.parts[partNumber - 1];

    const abortController = new AbortController();
    const leaseId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.downloadLeaseMs).toISOString();
    let released = false;
    let expiryTimer: ReturnType<typeof setTimeout>;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(expiryTimer);
      if (this.activeDownload?.leaseId === leaseId) this.activeDownload = undefined;
      if (job.expiryPending) this.expireCompletedJob(job.id);
    };
    expiryTimer = setTimeout(() => {
      abortController.abort(new Error("Export download lease expired"));
      release();
    }, this.downloadLeaseMs);
    expiryTimer.unref?.();
    const activeDownload: ActiveDownload = { leaseId, jobId, abortController, expiryTimer };
    this.activeDownload = activeDownload;

    return {
      acquired: true,
      lease: {
        jobId,
        outputPath: job.outputPaths[partNumber - 1],
        sizeBytes: part.sizeBytes,
        sha256: part.sha256,
        partNumber,
        expiresAt,
        signal: abortController.signal,
        release,
      },
    };
  }

  waitForIdle(): Promise<void> {
    if (!this.activeJobId && this.queuedIds.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private startNext(): void {
    if (this.activeJobId) return;
    if (this.queuedIds.length && !this.canStart()) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.startNext();
        }, this.retryDelayMs);
        this.retryTimer.unref?.();
      }
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const jobId = this.queuedIds.shift();
    if (!jobId) {
      this.resolveIdleWaiters();
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job || !job.hasRequest) {
      this.startNext();
      return;
    }

    this.activeJobId = jobId;
    job.state = "running";
    job.startedAt = this.timestamp();
    const request = job.request as Request;

    void this.run(job, request).finally(() => {
      job.request = undefined;
      job.hasRequest = false;
      this.activeJobId = undefined;
      this.completedIds.push(job.id);
      if (job.state === "ready") {
        job.expiryTimer = setTimeout(() => this.expireCompletedJob(job.id), this.outputLeaseMs);
        job.expiryTimer.unref?.();
      }
      this.pruneCompletedHistory();
      this.startNext();
    });
  }

  private async run(job: MutableExportJob<Request>, request: Request): Promise<void> {
    let builtPaths: string[] | undefined;
    try {
      const built = await this.builder(request, { jobId: job.id });
      const outputPaths = typeof built === "string" ? [built] : [...built];
      builtPaths = outputPaths;
      if (!outputPaths.length || outputPaths.some((outputPath) => typeof outputPath !== "string" || outputPath.length === 0)) {
        throw new TypeError("Export builder did not return a final file path.");
      }
      const digests = await Promise.all(outputPaths.map((outputPath) => sha256FileStreamed(outputPath)));
      const sizeBytes = digests.reduce((total, digest) => total + digest.sizeBytes, 0);
      this.releaseReservation(job);
      const protectedLimit = this.currentProtectedLimit();
      if (protectedLimit !== undefined && this.protectedOutputBytes + this.reservedOutputBytes + sizeBytes > protectedLimit) {
        await this.onOutputsDiscarded?.(outputPaths);
        builtPaths = undefined;
        throw new ExportProtectedBytesError(protectedLimit);
      }
      this.onOutputsReady?.(outputPaths);
      job.outputPaths = outputPaths;
      job.outputsProtected = true;
      this.protectedOutputBytes += sizeBytes;
      job.parts = digests.map((digest, index) => ({ number: index + 1, ...digest }));
      job.sizeBytes = sizeBytes;
      if (digests.length === 1) job.sha256 = digests[0].sha256;
      job.state = "ready";
      builtPaths = undefined;
    } catch (error) {
      if (builtPaths) {
        try {
          await this.onOutputsDiscarded?.(builtPaths);
        } catch {
          // The bounded failed state remains authoritative even if best-effort
          // cleanup cannot remove an unpublished artifact immediately.
        }
      }
      job.state = "failed";
      job.error = boundedErrorMessage(error);
      this.releaseDeduplicationKey(job);
    } finally {
      this.releaseReservation(job);
      job.finishedAt = this.timestamp();
    }
  }

  private pruneCompletedHistory(): void {
    while (this.completedIds.length > this.completedHistoryLimit) {
      const removableIndex = this.completedIds.findIndex((jobId) => jobId !== this.activeDownload?.jobId);
      if (removableIndex < 0) return;
      const [oldestId] = this.completedIds.splice(removableIndex, 1);
      if (oldestId) {
        const oldest = this.jobs.get(oldestId);
        if (oldest) this.releaseJob(oldest);
      }
    }
  }

  private expireCompletedJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || (job.state !== "ready" && job.state !== "failed")) return;
    if (this.activeDownload?.jobId === jobId) {
      job.expiryPending = true;
      return;
    }
    const index = this.completedIds.indexOf(jobId);
    if (index >= 0) this.completedIds.splice(index, 1);
    this.releaseJob(job);
  }

  private releaseJob(job: MutableExportJob<Request>): void {
    if (job.expiryTimer) clearTimeout(job.expiryTimer);
    this.releaseReservation(job);
    if (job.outputsProtected && job.outputPaths) {
      this.onOutputsReleased?.(job.outputPaths);
      this.protectedOutputBytes = Math.max(0, this.protectedOutputBytes - (job.sizeBytes ?? 0));
      job.outputsProtected = false;
    }
    this.releaseDeduplicationKey(job);
    this.jobs.delete(job.id);
  }

  private releaseReservation(job: MutableExportJob<Request>): void {
    if (!job.reservedBytes) return;
    this.reservedOutputBytes = Math.max(0, this.reservedOutputBytes - job.reservedBytes);
    job.reservedBytes = 0;
  }

  private releaseDeduplicationKey(job: MutableExportJob<Request>): void {
    if (job.deduplicationKey && this.jobsByDeduplicationKey.get(job.deduplicationKey) === job.id) {
      this.jobsByDeduplicationKey.delete(job.deduplicationKey);
    }
  }

  private currentProtectedLimit(): number | undefined {
    if (!this.maxProtectedOutputBytes) return undefined;
    const limit = this.maxProtectedOutputBytes();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("maxProtectedOutputBytes provider returned an invalid bound");
    return limit;
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.idFactory();
      if (candidate && !this.jobs.has(candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique export job ID.");
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function snapshot<Request>(job: MutableExportJob<Request>): ExportJobSnapshot {
  return {
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.sizeBytes !== undefined ? { sizeBytes: job.sizeBytes } : {}),
    ...(job.sha256 ? { sha256: job.sha256 } : {}),
    ...(job.parts ? { parts: job.parts.map((part) => ({ ...part })) } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Export build failed.").slice(0, 1_024);
}
