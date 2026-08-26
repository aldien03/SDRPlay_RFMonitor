import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

export const MAX_SCREENSHOT_PNG_BYTES = 2 * 1024 * 1024 - 4 * 1024;
export const MAX_SCREENSHOT_WIDTH = 8_192;
export const MAX_SCREENSHOT_HEIGHT = 8_192;
export const MAX_SCREENSHOT_PIXELS = 16_777_216;
export const MAX_SCREENSHOT_BODIES_IN_FLIGHT = 2;
export const MAX_SCREENSHOTS_PER_EVENT = 8;
export const MAX_SCREENSHOT_BYTES_PER_EVENT = 8 * 1024 * 1024;
export const MAX_SCREENSHOTS_GLOBAL = 256;
export const MAX_SCREENSHOT_BYTES_GLOBAL = 64 * 1024 * 1024;

const MAX_SCREENSHOT_SCAN_SESSIONS = 4_096;
const MAX_SCREENSHOT_SCAN_ENTRIES = 4_096;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const LEGACY_SCREENSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.png$/;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 4_096;

export class ScreenshotPngError extends Error {
  readonly code = "SCREENSHOT_INVALID_PNG";

  constructor(message: string) {
    super(message);
    this.name = "ScreenshotPngError";
  }
}

export class ScreenshotBodyGate {
  private activeBodies = 0;

  get active(): number {
    return this.activeBodies;
  }

  tryAcquire(): (() => void) | undefined {
    if (this.activeBodies >= MAX_SCREENSHOT_BODIES_IN_FLIGHT) return undefined;
    this.activeBodies += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeBodies = Math.max(0, this.activeBodies - 1);
    };
  }
}

export function validateScreenshotPng(png: Buffer): { width: number; height: number } {
  if (png.byteLength === 0 || png.byteLength > MAX_SCREENSHOT_PNG_BYTES) {
    throw new ScreenshotPngError(`PNG screenshots must contain 1 to ${MAX_SCREENSHOT_PNG_BYTES} bytes`);
  }
  if (png.byteLength < 45 || !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new ScreenshotPngError("PNG signature or structure is invalid");
  }

  let offset = PNG_SIGNATURE.byteLength;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < png.byteLength) {
    chunks += 1;
    if (chunks > MAX_PNG_CHUNKS || offset + 12 > png.byteLength) {
      throw new ScreenshotPngError("PNG chunk structure exceeds its bound");
    }
    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > png.byteLength) {
      throw new ScreenshotPngError("PNG chunk length is invalid");
    }
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ScreenshotPngError("PNG chunk type is invalid");
    if (chunks === 1 && (type !== "IHDR" || length !== 13)) {
      throw new ScreenshotPngError("PNG must begin with one bounded IHDR chunk");
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new ScreenshotPngError("PNG IHDR chunk is invalid");
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      const bitDepth = png[offset + 16];
      const colorType = png[offset + 17];
      const compression = png[offset + 18];
      const filter = png[offset + 19];
      const interlace = png[offset + 20];
      const validBitDepth = [1, 2, 4, 8, 16].includes(bitDepth);
      const validColorType = [0, 2, 3, 4, 6].includes(colorType);
      if (!width || !height || width > MAX_SCREENSHOT_WIDTH || height > MAX_SCREENSHOT_HEIGHT
        || width * height > MAX_SCREENSHOT_PIXELS) {
        throw new ScreenshotPngError("PNG dimensions exceed the screenshot bound");
      }
      if (!validBitDepth || !validColorType || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        throw new ScreenshotPngError("PNG IHDR encoding fields are invalid");
      }
      sawHeader = true;
    } else if (!sawHeader) {
      throw new ScreenshotPngError("PNG data appeared before IHDR");
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== png.byteLength) {
        throw new ScreenshotPngError("PNG IEND structure is invalid");
      }
      sawEnd = true;
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawImageData || !sawEnd || offset !== png.byteLength) {
    throw new ScreenshotPngError("PNG is missing required bounded chunks");
  }
  return { width, height };
}

export interface ScreenshotAdmissionLease {
  readonly eventId: string;
  readonly reservedBytes: number;
  commit(actualBytes: number): void;
  release(): void;
}

export interface PersistedScreenshotRecord {
  eventId: string;
  bytes: number;
}

export interface PersistedScreenshotUsage {
  records: PersistedScreenshotRecord[];
  complete: boolean;
  saturated: boolean;
  scannedSessions: number;
  scannedEntries: number;
  failure?: string;
}

export interface PersistedScreenshotScanOptions {
  maxSessions?: number;
  maxEntries?: number;
  globalCount?: number;
  globalBytes?: number;
}

export type ScreenshotAdmissionResult =
  | { admitted: true; lease: ScreenshotAdmissionLease }
  | { admitted: false; reason: "count" | "bytes" | "rate"; retryAfterSeconds: number };

export interface ScreenshotAdmissionOptions {
  now?: () => number;
  perEventCount?: number;
  perEventBytes?: number;
  globalCount?: number;
  globalBytes?: number;
  rateWindowMs?: number;
  perEventRate?: number;
  globalRate?: number;
  globalWindowMs?: number;
}

interface EventUsage {
  count: number;
  bytes: number;
  reservedCount: number;
  reservedBytes: number;
  rate: number[];
  lastAt: number;
}

interface GlobalRecord {
  bytes: number;
}

export class ScreenshotAdmissionController {
  private readonly now: () => number;
  private readonly perEventCount: number;
  private readonly perEventBytes: number;
  private readonly globalCount: number;
  private readonly globalBytes: number;
  private readonly rateWindowMs: number;
  private readonly perEventRate: number;
  private readonly globalRate: number;
  private readonly globalWindowMs: number;
  private readonly events = new Map<string, EventUsage>();
  private readonly globalRecords: GlobalRecord[] = [];
  private readonly globalRateRecords: number[] = [];
  private reservedCount = 0;
  private reservedBytes = 0;

  constructor(options: ScreenshotAdmissionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.perEventCount = positiveInteger(options.perEventCount ?? MAX_SCREENSHOTS_PER_EVENT, "perEventCount");
    this.perEventBytes = positiveInteger(options.perEventBytes ?? MAX_SCREENSHOT_BYTES_PER_EVENT, "perEventBytes");
    this.globalCount = positiveInteger(options.globalCount ?? MAX_SCREENSHOTS_GLOBAL, "globalCount");
    this.globalBytes = positiveInteger(options.globalBytes ?? MAX_SCREENSHOT_BYTES_GLOBAL, "globalBytes");
    this.rateWindowMs = positiveInteger(options.rateWindowMs ?? 60_000, "rateWindowMs");
    this.perEventRate = positiveInteger(options.perEventRate ?? 4, "perEventRate");
    this.globalRate = positiveInteger(options.globalRate ?? 12, "globalRate");
    this.globalWindowMs = positiveInteger(options.globalWindowMs ?? 24 * 60 * 60_000, "globalWindowMs");
  }

  get trackedEventCount(): number {
    return this.events.size;
  }

  get committedUsage(): { count: number; bytes: number } {
    return {
      count: this.globalRecords.length,
      bytes: this.globalRecords.reduce((total, record) => total + record.bytes, 0),
    };
  }

  get quotaLimits(): { globalCount: number; globalBytes: number } {
    return { globalCount: this.globalCount, globalBytes: this.globalBytes };
  }

  /**
   * Replace only committed usage at a process-start boundary. The caller must
   * derive these records from the domain's evidence tree; rate limits remain
   * deliberately process-local.
   */
  loadCommitted(records: readonly PersistedScreenshotRecord[]): void {
    if (this.reservedCount || this.reservedBytes) throw new Error("Cannot reload screenshot quota while uploads are reserved");
    this.events.clear();
    this.globalRecords.length = 0;
    this.globalRateRecords.length = 0;
    const now = this.now();
    for (const record of records) {
      if (!SAFE_IDENTIFIER.test(record.eventId) || record.eventId.length > 128) {
        throw new TypeError("Persisted screenshot has an invalid event ID");
      }
      if (!Number.isSafeInteger(record.bytes) || record.bytes < 1) {
        throw new RangeError("Persisted screenshot has an invalid byte count");
      }
      const usage = this.events.get(record.eventId) ?? {
        count: 0,
        bytes: 0,
        reservedCount: 0,
        reservedBytes: 0,
        rate: [],
        lastAt: now,
      };
      usage.count += 1;
      usage.bytes += record.bytes;
      usage.lastAt = now;
      this.events.set(record.eventId, usage);
      this.globalRecords.push({ bytes: record.bytes });
    }
  }

  reserve(eventId: string, bytes: number): ScreenshotAdmissionResult {
    if (!eventId || eventId.length > 128) throw new TypeError("A bounded event ID is required");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SCREENSHOT_PNG_BYTES) {
      throw new RangeError(`Screenshot reservation must contain 1 to ${MAX_SCREENSHOT_PNG_BYTES} bytes`);
    }
    const now = this.now();
    this.prune(now);
    const usage = this.events.get(eventId) ?? { count: 0, bytes: 0, reservedCount: 0, reservedBytes: 0, rate: [], lastAt: now };
    if (usage.rate.length >= this.perEventRate || this.globalRateRecords.length >= this.globalRate) {
      return { admitted: false, reason: "rate", retryAfterSeconds: retryAfter(now, usage.rate, this.globalRateRecords, this.rateWindowMs) };
    }
    if (usage.count + usage.reservedCount >= this.perEventCount
      || this.globalRecords.length + this.reservedCount >= this.globalCount) {
      return { admitted: false, reason: "count", retryAfterSeconds: 60 };
    }
    const globalBytes = this.globalRecords.reduce((total, record) => total + record.bytes, 0);
    if (usage.bytes + usage.reservedBytes + bytes > this.perEventBytes
      || globalBytes + this.reservedBytes + bytes > this.globalBytes) {
      return { admitted: false, reason: "bytes", retryAfterSeconds: 60 };
    }

    this.events.set(eventId, usage);
    usage.lastAt = now;
    usage.reservedCount += 1;
    usage.reservedBytes += bytes;
    usage.rate.push(now);
    this.reservedCount += 1;
    this.reservedBytes += bytes;
    this.globalRateRecords.push(now);
    let settled = false;
    const settleReservation = () => {
      usage.reservedCount = Math.max(0, usage.reservedCount - 1);
      usage.reservedBytes = Math.max(0, usage.reservedBytes - bytes);
      this.reservedCount = Math.max(0, this.reservedCount - 1);
      this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
    };
    return {
      admitted: true,
      lease: {
        eventId,
        reservedBytes: bytes,
        commit: (actualBytes) => {
          if (settled) return;
          if (!Number.isSafeInteger(actualBytes) || actualBytes < 1 || actualBytes > bytes) {
            throw new RangeError("Screenshot body exceeded its admission reservation");
          }
          settled = true;
          settleReservation();
          usage.count += 1;
          usage.bytes += actualBytes;
          this.globalRecords.push({ bytes: actualBytes });
        },
        release: () => {
          if (settled) return;
          settled = true;
          settleReservation();
        },
      },
    };
  }

  private prune(now: number): void {
    while (this.globalRateRecords[0] !== undefined && now - this.globalRateRecords[0] >= this.rateWindowMs) this.globalRateRecords.shift();
    for (const [eventId, usage] of this.events) {
      while (usage.rate[0] !== undefined && now - usage.rate[0] >= this.rateWindowMs) usage.rate.shift();
      if (!usage.count && !usage.reservedCount && now - usage.lastAt >= this.globalWindowMs) this.events.delete(eventId);
    }
  }
}

/**
 * Reconstruct committed count and byte use directly from one field or test
 * evidence root. Traversal and retained state are hard-bounded. If the tree
 * cannot be inspected completely before a quota is proven full, callers must
 * fail closed for supplemental screenshot uploads.
 */
export async function scanPersistedScreenshotUsage(
  root: string,
  options: PersistedScreenshotScanOptions = {},
): Promise<PersistedScreenshotUsage> {
  const maxSessions = positiveInteger(options.maxSessions ?? MAX_SCREENSHOT_SCAN_SESSIONS, "maxSessions");
  const maxEntries = positiveInteger(options.maxEntries ?? MAX_SCREENSHOT_SCAN_ENTRIES, "maxEntries");
  const globalCount = positiveInteger(options.globalCount ?? MAX_SCREENSHOTS_GLOBAL, "globalCount");
  const globalBytes = positiveInteger(options.globalBytes ?? MAX_SCREENSHOT_BYTES_GLOBAL, "globalBytes");
  const records: PersistedScreenshotRecord[] = [];
  let totalBytes = 0;
  let scannedSessions = 0;
  let scannedEntries = 0;
  let complete = true;
  let saturated = false;
  let failure: string | undefined;

  const stopWithFailure = (reason: string): void => {
    complete = false;
    failure = reason;
  };
  const inspectEntry = (): boolean => {
    scannedEntries += 1;
    if (scannedEntries <= maxEntries) return true;
    stopWithFailure("screenshot scan entry bound reached");
    return false;
  };
  const addFile = async (filePath: string, eventId: string): Promise<boolean> => {
    if (!SAFE_IDENTIFIER.test(eventId) || eventId.length > 128) {
      stopWithFailure("screenshot event path is invalid");
      return false;
    }
    let details;
    try {
      details = await lstat(filePath);
    } catch {
      stopWithFailure("screenshot file changed during quota inspection");
      return false;
    }
    if (!details.isFile() || details.isSymbolicLink() || !Number.isSafeInteger(details.size) || details.size < 1) {
      stopWithFailure("screenshot evidence is not one bounded regular file");
      return false;
    }
    records.push({ eventId, bytes: details.size });
    totalBytes += details.size;
    if (records.length >= globalCount || totalBytes >= globalBytes) {
      saturated = true;
      return false;
    }
    return true;
  };

  try {
    const rootDirectory = await opendir(root);
    scanRoot: for await (const rootEntry of rootDirectory) {
      if (!inspectEntry()) break;
      if (!rootEntry.name.startsWith("session-")) continue;
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
        stopWithFailure("evidence session path is not a regular directory");
        break;
      }
      scannedSessions += 1;
      if (scannedSessions > maxSessions) {
        stopWithFailure("screenshot scan session bound reached");
        break;
      }
      const screenshotRoot = path.join(root, rootEntry.name, "screenshots");
      let screenshotDetails;
      try {
        screenshotDetails = await lstat(screenshotRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        stopWithFailure("screenshot directory could not be inspected");
        break;
      }
      if (!screenshotDetails.isDirectory() || screenshotDetails.isSymbolicLink()) {
        stopWithFailure("screenshot path is not a regular directory");
        break;
      }
      const screenshotDirectory = await opendir(screenshotRoot);
      for await (const entry of screenshotDirectory) {
        if (!inspectEntry()) break scanRoot;
        if (entry.isSymbolicLink()) {
          stopWithFailure("linked screenshot evidence is not allowed");
          break scanRoot;
        }
        const entryPath = path.join(screenshotRoot, entry.name);
        if (entry.isDirectory()) {
          const eventId = entry.name;
          if (!SAFE_IDENTIFIER.test(eventId) || eventId.length > 128) {
            stopWithFailure("screenshot event directory is invalid");
            break scanRoot;
          }
          const eventDirectory = await opendir(entryPath);
          for await (const image of eventDirectory) {
            if (!inspectEntry()) break scanRoot;
            if (image.isDirectory() || image.isSymbolicLink()) {
              stopWithFailure("nested or linked screenshot evidence is not allowed");
              break scanRoot;
            }
            if (!image.name.endsWith(".png")) continue;
            if (!image.isFile()) {
              stopWithFailure("screenshot evidence is not a regular PNG file");
              break scanRoot;
            }
            if (!await addFile(path.join(entryPath, image.name), eventId)) break scanRoot;
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
        const legacy = entry.name.match(LEGACY_SCREENSHOT_NAME);
        if (!legacy || !await addFile(entryPath, legacy[1])) break scanRoot;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      stopWithFailure(error instanceof Error ? error.message : "screenshot quota inspection failed");
    }
  }

  return {
    records,
    complete,
    saturated,
    scannedSessions: Math.min(scannedSessions, maxSessions),
    scannedEntries: Math.min(scannedEntries, maxEntries),
    ...(failure ? { failure } : {}),
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function retryAfter(now: number, eventRate: readonly number[], globalRate: readonly number[], windowMs: number): number {
  const oldest = Math.min(eventRate[0] ?? Number.POSITIVE_INFINITY, globalRate[0] ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(oldest) ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1_000)) : 1;
}
