import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  DataDomain,
  EvidenceReplayBatch,
  EvidenceReplayFrame,
  EvidenceReplaySpectrumFrame,
  EvidenceSession,
  SignalMetricSample,
} from "../shared/types";
import { inspectEvidenceCommitMetadata } from "./evidenceVerifier";

const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_LINE_BYTES = 1024 * 1024;
const MAX_BATCH_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_STORED_FRAME_BINS = 2_048;
const MAX_BATCH_FRAMES = 16;
const READ_BLOCK_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 100_000;
const MAX_REPLAY_INDEX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REPLAY_RAW_BYTES = 128 * 1024 * 1024;
const MAX_VERIFICATION_CACHE_ENTRIES = 128;
const MAX_CONCURRENT_HASHES = 2;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const SESSION_PATTERN = /^session-[A-Za-z0-9._-]{1,192}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_METADATA_PATHS = ["finalization.json", "manifest.json", "SHA256SUMS.txt", "session-final.json"] as const;

export type EvidencePlaybackErrorCode =
  | "EVIDENCE_REPLAY_NOT_FOUND"
  | "EVIDENCE_REPLAY_NOT_ELIGIBLE"
  | "EVIDENCE_REPLAY_INCOMPLETE_UNLABELLED"
  | "EVIDENCE_REPLAY_CURSOR_INVALID"
  | "EVIDENCE_REPLAY_SOURCE_INVALID";

export class EvidencePlaybackError extends Error {
  constructor(
    readonly code: EvidencePlaybackErrorCode,
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "EvidencePlaybackError";
  }
}

interface ReplayCursor {
  v: 1;
  sessionId: string;
  byteOffset: number;
}

interface IndexedFrame {
  frame: Record<string, unknown>;
  rawFile: string;
  rawOffset: number;
  rawLength: number;
  summary: Record<string, unknown>;
}

interface ReplayManifestEntry {
  bytes: number;
  sha256: string;
}

interface ReplayManifest {
  entries: Map<string, ReplayManifestEntry>;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface VerifiedFile {
  identity: FileIdentity;
}

class HashLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_HASHES) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const hashLimiter = new HashLimiter();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceInvalid(message: string): EvidencePlaybackError {
  return new EvidencePlaybackError("EVIDENCE_REPLAY_SOURCE_INVALID", 409, message);
}

function fileIdentity(details: BigIntStats): FileIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularIdentity(details: BigIntStats, expectedBytes: number, maximumBytes: number, relativePath: string): FileIdentity {
  if (
    !details.isFile()
    || details.size < 0n
    || details.size !== BigInt(expectedBytes)
    || details.size > BigInt(maximumBytes)
  ) throw sourceInvalid(`Evidence replay manifest size does not match ${relativePath}`);
  return fileIdentity(details);
}

function safeRelativePath(value: string, expectedPrefix?: string): string {
  if (
    !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || (expectedPrefix && !value.startsWith(expectedPrefix))
  ) throw sourceInvalid("Evidence replay contains an invalid relative path");
  return value;
}

async function assertNoSymlinkPath(root: string, relativePath: string): Promise<string> {
  const safe = safeRelativePath(relativePath);
  let current = root;
  for (const segment of safe.split("/")) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw sourceInvalid("Evidence replay refuses symbolic links");
  }
  const resolved = path.resolve(current);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sourceInvalid("Evidence replay path leaves its session");
  }
  return resolved;
}

async function rejectCommitMetadataSymlinks(sessionPath: string): Promise<void> {
  for (const relativePath of COMMIT_METADATA_PATHS) {
    try {
      await assertNoSymlinkPath(sessionPath, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function openRegularNoFollow(filePath: string, maximumBytes?: number, allowEmpty = false): Promise<FileHandle> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || (!allowEmpty && details.size <= 0) || (maximumBytes !== undefined && details.size > maximumBytes)) {
      throw sourceInvalid(`Evidence replay file is outside its resource bound: ${path.basename(filePath)}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readBoundedJson(filePath: string, maximumBytes: number): Promise<Record<string, unknown>> {
  const handle = await openRegularNoFollow(filePath, maximumBytes);
  try {
    const details = await handle.stat();
    const buffer = Buffer.allocUnsafe(details.size);
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (read.bytesRead !== buffer.byteLength) throw sourceInvalid(`Evidence replay file was truncated: ${path.basename(filePath)}`);
    const value = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!isRecord(value)) throw sourceInvalid(`Evidence replay JSON is not an object: ${path.basename(filePath)}`);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw sourceInvalid(`Evidence replay JSON is malformed: ${path.basename(filePath)}`);
    throw error;
  } finally {
    await handle.close();
  }
}

async function readBoundedJsonWithDigest(filePath: string, maximumBytes: number): Promise<{
  value: Record<string, unknown>;
  sha256: string;
}> {
  const handle = await openRegularNoFollow(filePath, maximumBytes);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximumBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw sourceInvalid(`Evidence replay file is outside its resource bound: ${path.basename(filePath)}`);
    }
    const buffer = Buffer.allocUnsafe(Number(before.size));
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (read.bytesRead !== buffer.byteLength) throw sourceInvalid(`Evidence replay file was truncated: ${path.basename(filePath)}`);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after))) {
      throw sourceInvalid(`Evidence replay file changed while being read: ${path.basename(filePath)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    } catch {
      throw sourceInvalid(`Evidence replay JSON is malformed: ${path.basename(filePath)}`);
    }
    if (!isRecord(parsed)) throw sourceInvalid(`Evidence replay JSON is not an object: ${path.basename(filePath)}`);
    return { value: parsed, sha256: createHash("sha256").update(buffer).digest("hex") };
  } finally {
    await handle.close();
  }
}

function encodeCursor(cursor: ReplayCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, sessionId: string): number {
  if (value === undefined || value === "") return 0;
  if (!CURSOR_PATTERN.test(value)) {
    throw new EvidencePlaybackError("EVIDENCE_REPLAY_CURSOR_INVALID", 400, "Evidence replay cursor is invalid");
  }
  try {
    const decodedText = Buffer.from(value, "base64url").toString("utf8");
    const decoded = JSON.parse(decodedText) as unknown;
    if (
      !isRecord(decoded)
      || decoded.v !== 1
      || decoded.sessionId !== sessionId
      || !Number.isSafeInteger(decoded.byteOffset)
      || (decoded.byteOffset as number) < 0
      || encodeCursor(decoded as unknown as ReplayCursor) !== value
    ) throw new Error("invalid");
    return decoded.byteOffset as number;
  } catch {
    throw new EvidencePlaybackError("EVIDENCE_REPLAY_CURSOR_INVALID", 400, "Evidence replay cursor is invalid");
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function committedManifestSha256(
  value: Record<string, unknown>,
  sessionId: string,
  dataDomain: DataDomain,
  committedAt?: string,
): string {
  if (
    value.schemaVersion !== 1
    || value.sessionId !== sessionId
    || value.dataDomain !== dataDomain
    || value.lifecycle !== "Complete"
    || typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt))
    || (committedAt !== undefined && value.committedAt !== committedAt)
    || typeof value.manifestSha256 !== "string" || !SHA256_PATTERN.test(value.manifestSha256)
    || typeof value.sha256SumsSha256 !== "string" || !SHA256_PATTERN.test(value.sha256SumsSha256)
    || typeof value.recordSha256 !== "string" || !SHA256_PATTERN.test(value.recordSha256)
  ) throw sourceInvalid("Complete evidence replay finalization record is invalid");
  const expectedRecordSha256 = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    sessionId: value.sessionId,
    dataDomain: value.dataDomain,
    lifecycle: value.lifecycle,
    committedAt: value.committedAt,
    manifestSha256: value.manifestSha256,
    sha256SumsSha256: value.sha256SumsSha256,
  })).digest("hex");
  if (value.recordSha256 !== expectedRecordSha256) {
    throw sourceInvalid("Complete evidence replay finalization record hash does not match");
  }
  return value.manifestSha256;
}

function replayManifest(
  value: Record<string, unknown>,
  sessionId: string,
  dataDomain: DataDomain,
): ReplayManifest {
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.sessionId !== sessionId
    || value.hashAlgorithm !== "SHA-256"
    || !Array.isArray(value.files)
    || value.files.length > MAX_MANIFEST_FILES
    || value.complete !== true
    || value.evidenceGap === true
    || (value.schemaVersion === 2 && value.dataDomain !== dataDomain)
  ) throw sourceInvalid("Complete evidence replay manifest is invalid");
  const entries = new Map<string, ReplayManifestEntry>();
  for (const candidate of value.files) {
    if (
      !isRecord(candidate)
      || typeof candidate.path !== "string"
      || !safeInteger(candidate.bytes)
      || typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256)
    ) throw sourceInvalid("Complete evidence replay manifest contains an invalid entry");
    const relativePath = safeRelativePath(candidate.path);
    if (relativePath === "manifest.json" || relativePath === "SHA256SUMS.txt" || entries.has(relativePath)) {
      throw sourceInvalid("Complete evidence replay manifest contains a duplicate or reserved entry");
    }
    entries.set(relativePath, { bytes: candidate.bytes, sha256: candidate.sha256 });
  }
  return { entries };
}

function optionalString(target: EvidenceReplaySpectrumFrame, key: keyof EvidenceReplaySpectrumFrame, value: unknown): void {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) {
    (target as unknown as Record<string, unknown>)[key as string] = value;
  }
}

function optionalNumber(target: EvidenceReplaySpectrumFrame, key: keyof EvidenceReplaySpectrumFrame, value: unknown, integer = false): void {
  if (finite(value) && (!integer || Number.isSafeInteger(value))) {
    (target as unknown as Record<string, unknown>)[key as string] = value;
  }
}

function decodeIndexedFrame(value: unknown): IndexedFrame {
  if (!isRecord(value) || !isRecord(value.frame)) throw sourceInvalid("Evidence replay index is missing frame metadata");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw sourceInvalid("Evidence replay index schema is unsupported");
  }
  if (typeof value.rawFile !== "string" || value.rawEncoding !== "uint8") {
    throw sourceInvalid("Evidence replay index is missing its uint8 source");
  }
  const rawFile = safeRelativePath(value.rawFile, "spectrum/raw/");
  if (!rawFile.endsWith(".bin")) throw sourceInvalid("Evidence replay raw source is not a binary FFT chunk");
  if (!safeInteger(value.rawOffset) || !safeInteger(value.rawLength, 1) || value.rawLength > MAX_STORED_FRAME_BINS) {
    throw sourceInvalid("Evidence replay index contains an invalid raw range");
  }
  if (!Number.isSafeInteger(value.rawOffset + value.rawLength)) throw sourceInvalid("Evidence replay raw range overflows");
  return {
    frame: value.frame,
    rawFile,
    rawOffset: value.rawOffset,
    rawLength: value.rawLength,
    summary: value,
  };
}

function replayFrame(indexed: IndexedFrame, bins: Buffer, expectedDomain: DataDomain): EvidenceReplayFrame {
  const source = indexed.frame.source;
  if (
    typeof indexed.frame.id !== "string" || !indexed.frame.id || indexed.frame.id.length > 256
    || typeof indexed.frame.timestamp !== "string" || !Number.isFinite(Date.parse(indexed.frame.timestamp))
    || !safeInteger(indexed.frame.receiver)
    || typeof indexed.frame.bandId !== "string" || !indexed.frame.bandId || indexed.frame.bandId.length > 256
    || !finite(indexed.frame.startHz)
    || !finite(indexed.frame.endHz)
    || indexed.frame.endHz <= indexed.frame.startHz
    || (source !== "sdrconnect" && source !== "simulation")
    || typeof indexed.frame.calibrated !== "boolean"
  ) throw sourceInvalid("Evidence replay frame metadata is invalid");
  if (indexed.frame.dataDomain !== undefined && indexed.frame.dataDomain !== expectedDomain) {
    throw sourceInvalid("Evidence replay frame crosses the data-domain boundary");
  }
  if (expectedDomain === "field" && source === "simulation") {
    throw sourceInvalid("Simulation data cannot be replayed from field evidence");
  }
  if (indexed.frame.analysisStartBin !== undefined && (!safeInteger(indexed.frame.analysisStartBin) || indexed.frame.analysisStartBin >= bins.length)) {
    throw sourceInvalid("Evidence replay analysis start is invalid");
  }
  if (indexed.frame.analysisEndBin !== undefined && (!safeInteger(indexed.frame.analysisEndBin, 1) || indexed.frame.analysisEndBin > bins.length)) {
    throw sourceInvalid("Evidence replay analysis end is invalid");
  }
  if (
    safeInteger(indexed.frame.analysisStartBin)
    && safeInteger(indexed.frame.analysisEndBin)
    && indexed.frame.analysisEndBin <= indexed.frame.analysisStartBin
  ) throw sourceInvalid("Evidence replay analysis mask is invalid");

  const frame: EvidenceReplaySpectrumFrame = {
    id: indexed.frame.id,
    timestamp: indexed.frame.timestamp,
    receiver: indexed.frame.receiver,
    bandId: indexed.frame.bandId,
    startHz: indexed.frame.startHz,
    endHz: indexed.frame.endHz,
    bins: Array.from(bins),
    source,
    calibrated: indexed.frame.calibrated,
  };
  optionalString(frame, "targetId", indexed.frame.targetId);
  optionalString(frame, "scanWindowId", indexed.frame.scanWindowId);
  optionalString(frame, "visitId", indexed.frame.visitId);
  optionalString(frame, "tuneConfirmedAt", indexed.frame.tuneConfirmedAt);
  if (indexed.frame.dataDomain === "field" || indexed.frame.dataDomain === "test") frame.dataDomain = indexed.frame.dataDomain;
  if (indexed.frame.binning === "native" || indexed.frame.binning === "peak-preserving") frame.binning = indexed.frame.binning;
  optionalNumber(frame, "inputBinCount", indexed.frame.inputBinCount, true);
  optionalNumber(frame, "configurationEpoch", indexed.frame.configurationEpoch, true);
  optionalNumber(frame, "tuneEpoch", indexed.frame.tuneEpoch, true);
  optionalNumber(frame, "visitEpoch", indexed.frame.visitEpoch, true);
  optionalNumber(frame, "receivedMonotonicMs", indexed.frame.receivedMonotonicMs);
  optionalNumber(frame, "requestedCenterHz", indexed.frame.requestedCenterHz);
  optionalNumber(frame, "confirmedCenterHz", indexed.frame.confirmedCenterHz);
  optionalNumber(frame, "confirmedSampleRateHz", indexed.frame.confirmedSampleRateHz);
  optionalNumber(frame, "analysisStartBin", indexed.frame.analysisStartBin, true);
  optionalNumber(frame, "analysisEndBin", indexed.frame.analysisEndBin, true);
  optionalNumber(frame, "analysisSpanHz", indexed.frame.analysisSpanHz);
  optionalNumber(frame, "captureSpanHz", indexed.frame.captureSpanHz);

  const metricFields = ["meanLevel", "peakLevel", "baselineLevel", "baselineDelta", "occupiedRatio"] as const;
  let metrics: SignalMetricSample | undefined;
  if (metricFields.every((field) => finite(indexed.summary[field])) && typeof indexed.summary.overload === "boolean") {
    metrics = {
      timestamp: typeof indexed.summary.timestamp === "string" && Number.isFinite(Date.parse(indexed.summary.timestamp))
        ? indexed.summary.timestamp
        : frame.timestamp,
      bandId: typeof indexed.summary.bandId === "string" ? indexed.summary.bandId : frame.bandId,
      meanLevel: indexed.summary.meanLevel as number,
      peakLevel: indexed.summary.peakLevel as number,
      baselineLevel: indexed.summary.baselineLevel as number,
      baselineDelta: indexed.summary.baselineDelta as number,
      occupiedRatio: indexed.summary.occupiedRatio as number,
      overload: indexed.summary.overload,
    };
    if (finite(indexed.summary.vendorReportedSignalPower)) metrics.vendorReportedSignalPower = indexed.summary.vendorReportedSignalPower;
    if (finite(indexed.summary.snrDb)) metrics.snrDb = indexed.summary.snrDb;
    if (finite(indexed.summary.medianRobustZ)) metrics.medianRobustZ = indexed.summary.medianRobustZ;
    if (finite(indexed.summary.peakRobustZ)) metrics.peakRobustZ = indexed.summary.peakRobustZ;
    if (finite(indexed.summary.maximumOccupiedWidthRatio)) metrics.maximumOccupiedWidthRatio = indexed.summary.maximumOccupiedWidthRatio;
  }
  return { frame, ...(metrics ? { metrics } : {}) };
}

/** Replay of one capture window (an incident's), not every window the receiver visited. */
export interface ReplayFrameFilter {
  targetId?: string;
  bandId?: string;
}

function matchesFilter(frame: Record<string, unknown>, filter: ReplayFrameFilter): boolean {
  if (filter.targetId && typeof frame.targetId === "string") return frame.targetId === filter.targetId;
  return !filter.bandId || frame.bandId === filter.bandId;
}

async function readIndexRecords(handle: FileHandle, startOffset: number, limit: number, filter?: ReplayFrameFilter): Promise<{
  records: IndexedFrame[];
  nextOffset: number;
  done: boolean;
}> {
  const details = await handle.stat();
  if (!details.isFile() || !Number.isSafeInteger(details.size)) throw sourceInvalid("Evidence replay index is invalid");
  if (startOffset > details.size) {
    throw new EvidencePlaybackError("EVIDENCE_REPLAY_CURSOR_INVALID", 400, "Evidence replay cursor is outside the session");
  }
  if (startOffset > 0) {
    const previous = Buffer.allocUnsafe(1);
    const read = await handle.read(previous, 0, 1, startOffset - 1);
    if (read.bytesRead !== 1 || previous[0] !== 0x0a) {
      throw new EvidencePlaybackError("EVIDENCE_REPLAY_CURSOR_INVALID", 400, "Evidence replay cursor is not at a record boundary");
    }
  }

  const records: IndexedFrame[] = [];
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let position = startOffset;
  let nextOffset = startOffset;
  let stopped = false;
  while (position < details.size && records.length < limit && !stopped) {
    const requested = Math.min(READ_BLOCK_BYTES, details.size - position);
    const block = Buffer.allocUnsafe(requested);
    const read = await handle.read(block, 0, block.byteLength, position);
    if (read.bytesRead <= 0) break;
    const chunk = block.subarray(0, read.bytesRead);
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const newline = chunk.indexOf(0x0a, chunkOffset);
      if (newline < 0) {
        const piece = chunk.subarray(chunkOffset);
        pending.push(piece);
        pendingBytes += piece.byteLength;
        if (pendingBytes > MAX_INDEX_LINE_BYTES) throw sourceInvalid("Evidence replay index line exceeds its resource bound");
        break;
      }
      const piece = chunk.subarray(chunkOffset, newline);
      const lineBytes = pendingBytes + piece.byteLength;
      if (lineBytes > MAX_INDEX_LINE_BYTES) throw sourceInvalid("Evidence replay index line exceeds its resource bound");
      const line = pending.length ? Buffer.concat([...pending, piece], lineBytes) : piece;
      pending.length = 0;
      pendingBytes = 0;
      nextOffset = position + newline + 1;
      if (!filter && nextOffset - startOffset > MAX_BATCH_SCAN_BYTES) throw sourceInvalid("Evidence replay batch exceeded its scan bound");
      if (!line.toString("utf8").trim()) throw sourceInvalid("Evidence replay index contains an empty record");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8")) as unknown;
      } catch {
        throw sourceInvalid("Evidence replay index contains malformed JSON");
      }
      const decoded = decodeIndexedFrame(parsed);
      if (!filter || matchesFilter(decoded.frame, filter)) records.push(decoded);
      chunkOffset = newline + 1;
      // A filtered batch may skip many other windows' frames: it stops at the
      // scan bound and returns what it found, with a cursor to continue.
      if (records.length >= limit || (filter && nextOffset - startOffset > MAX_BATCH_SCAN_BYTES)) {
        stopped = true;
        break;
      }
    }
    position += read.bytesRead;
  }
  if (!stopped && position >= details.size && pendingBytes > 0) {
    throw sourceInvalid("Evidence replay index ends with an unterminated record");
  }
  return { records, nextOffset, done: nextOffset >= details.size };
}

/** The line that starts at or after `offset`, with its frame time, or undefined past the end. */
async function indexLineAt(handle: FileHandle, offset: number, size: number): Promise<{ start: number; end: number; ms: number } | undefined> {
  let start = offset;
  if (offset > 0) {
    const probe = Buffer.allocUnsafe(Math.min(READ_BLOCK_BYTES, size - offset + 1));
    const read = await handle.read(probe, 0, probe.byteLength, offset - 1);
    const newline = probe.subarray(0, read.bytesRead).indexOf(0x0a);
    if (newline < 0) return undefined;
    start = offset - 1 + newline + 1;
  }
  if (start >= size) return undefined;
  const block = Buffer.allocUnsafe(Math.min(READ_BLOCK_BYTES, size - start));
  const read = await handle.read(block, 0, block.byteLength, start);
  const newline = block.subarray(0, read.bytesRead).indexOf(0x0a);
  if (newline < 0) return undefined;
  try {
    const parsed = JSON.parse(block.subarray(0, newline).toString("utf8")) as { frame?: { timestamp?: unknown } };
    const ms = typeof parsed.frame?.timestamp === "string" ? Date.parse(parsed.frame.timestamp) : Number.NaN;
    return Number.isFinite(ms) ? { start, end: start + newline + 1, ms } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record boundary of the first frame at or after `fromMs`, by binary search.
 * The index is only roughly time-ordered, so callers ask for a little lead-in.
 */
async function seekIndexOffset(handle: FileHandle, fromMs: number): Promise<number> {
  const { size } = await handle.stat();
  let low = 0;
  let high = size;
  for (let step = 0; step < 64 && high - low > READ_BLOCK_BYTES; step += 1) {
    const middle = Math.floor((low + high) / 2);
    const line = await indexLineAt(handle, middle, size);
    if (!line) {
      high = middle;
      continue;
    }
    if (line.ms < fromMs) low = line.end;
    else high = line.start;
  }
  // Finish within the last block: the first record at or after the time.
  const block = Buffer.allocUnsafe(Math.min(READ_BLOCK_BYTES * 2, size - low));
  const read = await handle.read(block, 0, block.byteLength, low);
  let offset = 0;
  while (offset < read.bytesRead) {
    const newline = block.subarray(0, read.bytesRead).indexOf(0x0a, offset);
    if (newline < 0) break;
    try {
      const parsed = JSON.parse(block.subarray(offset, newline).toString("utf8")) as { frame?: { timestamp?: unknown } };
      const ms = typeof parsed.frame?.timestamp === "string" ? Date.parse(parsed.frame.timestamp) : Number.NaN;
      if (Number.isFinite(ms) && ms >= fromMs) return low + offset;
    } catch {
      return low + offset; // The batch reader reports a damaged record itself.
    }
    offset = newline + 1;
  }
  return low + offset;
}

export class EvidencePlaybackReader {
  private readonly verificationCache = new Map<string, VerifiedFile>();

  constructor(
    private readonly root: string,
    private readonly dataDomain: DataDomain,
  ) {}

  private verificationKey(sessionPath: string, relativePath: string, entry: ReplayManifestEntry): string {
    return `${sessionPath}\0${relativePath}\0${entry.bytes}\0${entry.sha256}`;
  }

  private cachedIdentity(key: string, observed: FileIdentity): FileIdentity | undefined {
    const cached = this.verificationCache.get(key);
    if (!cached || !sameFileIdentity(cached.identity, observed)) return undefined;
    this.verificationCache.delete(key);
    this.verificationCache.set(key, cached);
    return observed;
  }

  private rememberVerification(key: string, identity: FileIdentity): void {
    this.verificationCache.delete(key);
    this.verificationCache.set(key, { identity });
    while (this.verificationCache.size > MAX_VERIFICATION_CACHE_ENTRIES) {
      const oldest = this.verificationCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.verificationCache.delete(oldest);
    }
  }

  private async verifyOpenManifestFile(
    handle: FileHandle,
    sessionPath: string,
    relativePath: string,
    entry: ReplayManifestEntry,
    maximumBytes: number,
  ): Promise<FileIdentity> {
    const key = this.verificationKey(sessionPath, relativePath, entry);
    const observed = assertRegularIdentity(await handle.stat({ bigint: true }), entry.bytes, maximumBytes, relativePath);
    const cached = this.cachedIdentity(key, observed);
    if (cached) return cached;

    return hashLimiter.run(async () => {
      const before = assertRegularIdentity(await handle.stat({ bigint: true }), entry.bytes, maximumBytes, relativePath);
      const cachedAfterWait = this.cachedIdentity(key, before);
      if (cachedAfterWait) return cachedAfterWait;

      const hash = createHash("sha256");
      const block = Buffer.allocUnsafe(READ_BLOCK_BYTES);
      let position = 0;
      while (position < entry.bytes) {
        const requested = Math.min(block.byteLength, entry.bytes - position);
        const read = await handle.read(block, 0, requested, position);
        if (read.bytesRead <= 0) throw sourceInvalid(`Evidence replay file was truncated while hashing: ${relativePath}`);
        hash.update(block.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      const after = assertRegularIdentity(await handle.stat({ bigint: true }), entry.bytes, maximumBytes, relativePath);
      if (!sameFileIdentity(before, after)) {
        throw sourceInvalid(`Evidence replay file changed while hashing: ${relativePath}`);
      }
      if (position !== entry.bytes || hash.digest("hex") !== entry.sha256) {
        throw sourceInvalid(`Evidence replay file hash does not match its committed manifest: ${relativePath}`);
      }
      this.rememberVerification(key, after);
      return after;
    });
  }

  private async assertStillVerified(handle: FileHandle, expected: FileIdentity, relativePath: string): Promise<void> {
    const observed = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(expected, observed)) {
      throw sourceInvalid(`Evidence replay file changed before it could be served: ${relativePath}`);
    }
  }

  private sessionPath(sessionId: string): string {
    if (!SESSION_PATTERN.test(sessionId)) {
      throw new EvidencePlaybackError("EVIDENCE_REPLAY_NOT_FOUND", 404, "Evidence replay session was not found");
    }
    const sessionPath = path.resolve(this.root, sessionId);
    const relative = path.relative(path.resolve(this.root), sessionPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new EvidencePlaybackError("EVIDENCE_REPLAY_NOT_FOUND", 404, "Evidence replay session was not found");
    }
    return sessionPath;
  }

  private async eligibleSession(sessionId: string): Promise<{
    session: EvidenceSession;
    sessionPath: string;
    manifest?: ReplayManifest;
  }> {
    const sessionPath = this.sessionPath(sessionId);
    try {
      const details = await lstat(sessionPath);
      if (!details.isDirectory() || details.isSymbolicLink()) throw sourceInvalid("Evidence replay session path is invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EvidencePlaybackError("EVIDENCE_REPLAY_NOT_FOUND", 404, "Evidence replay session was not found");
      }
      throw error;
    }
    const descriptorPath = await assertNoSymlinkPath(sessionPath, "session.json");
    const descriptor = await readBoundedJson(descriptorPath, MAX_DESCRIPTOR_BYTES);
    if (descriptor.id !== sessionId || (descriptor.dataDomain !== undefined && descriptor.dataDomain !== this.dataDomain)) {
      throw sourceInvalid("Evidence replay session identity does not match its storage domain");
    }
    if (!safeInteger(descriptor.frameCount) || !safeInteger(descriptor.eventCount) || !safeInteger(descriptor.byteCount)) {
      throw sourceInvalid("Evidence replay session counters are invalid");
    }
    if (descriptor.lifecycle !== "Complete" && descriptor.lifecycle !== "Incomplete") {
      throw new EvidencePlaybackError(
        "EVIDENCE_REPLAY_NOT_ELIGIBLE",
        409,
        `Only Complete or explicitly gap-labelled Incomplete sessions can be replayed; this session is ${String(descriptor.lifecycle ?? "legacy")}`,
      );
    }
    if (descriptor.status !== "closed") throw sourceInvalid("Finalized evidence replay has an invalid compatibility status");
    const reasons = Array.isArray(descriptor.incompleteReasons)
      ? descriptor.incompleteReasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0 && reason.length <= 256).slice(0, 32)
      : [];
    if (descriptor.lifecycle === "Incomplete" && (descriptor.evidenceGap !== true || reasons.length === 0)) {
      throw new EvidencePlaybackError(
        "EVIDENCE_REPLAY_INCOMPLETE_UNLABELLED",
        409,
        "Incomplete evidence replay requires an explicit recorded gap reason",
      );
    }
    await rejectCommitMetadataSymlinks(sessionPath);
    const commit = await inspectEvidenceCommitMetadata(sessionPath, {
      expectedDataDomain: this.dataDomain,
      expectedSessionId: sessionId,
    });
    if (descriptor.lifecycle === "Complete" && (commit.outcome !== "committed" || commit.lifecycle !== "Complete")) {
      throw sourceInvalid("Complete evidence replay is not durably committed");
    }
    if (descriptor.lifecycle === "Incomplete" && commit.outcome === "fail") {
      throw sourceInvalid(`Incomplete evidence replay commit is invalid: ${commit.reasons.join(",")}`);
    }
    if (descriptor.lifecycle === "Incomplete" && commit.outcome === "committed" && commit.lifecycle !== "Incomplete") {
      throw sourceInvalid("Incomplete evidence replay lifecycle differs from its commit");
    }
    let manifestRecord: Record<string, unknown> | undefined;
    let committedReplayManifest: ReplayManifest | undefined;
    if (descriptor.lifecycle === "Complete") {
      const finalizationPath = await assertNoSymlinkPath(sessionPath, "finalization.json");
      const manifestPath = await assertNoSymlinkPath(sessionPath, "manifest.json");
      const [finalizationRead, manifestRead] = await Promise.all([
        readBoundedJsonWithDigest(finalizationPath, MAX_DESCRIPTOR_BYTES),
        readBoundedJsonWithDigest(manifestPath, MAX_MANIFEST_BYTES),
      ]);
      const expectedManifestSha256 = committedManifestSha256(
        finalizationRead.value,
        sessionId,
        this.dataDomain,
        commit.committedAt,
      );
      if (manifestRead.sha256 !== expectedManifestSha256) {
        throw sourceInvalid("Complete evidence replay manifest does not match its finalization commit");
      }
      manifestRecord = manifestRead.value;
      committedReplayManifest = replayManifest(manifestRecord, sessionId, this.dataDomain);
    } else {
      try {
        manifestRecord = await readBoundedJson(await assertNoSymlinkPath(sessionPath, "manifest.json"), MAX_MANIFEST_BYTES);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (descriptor.lifecycle === "Incomplete" && manifestRecord) {
      const missingParts = Array.isArray(manifestRecord.missingParts)
        ? manifestRecord.missingParts.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
        : [];
      if (manifestRecord.complete !== false || manifestRecord.evidenceGap !== true || missingParts.length === 0) {
        throw sourceInvalid("Incomplete evidence replay manifest does not label its recorded gaps");
      }
    }
    return {
      session: {
        ...(descriptor as unknown as EvidenceSession),
        incompleteReasons: reasons,
      },
      sessionPath,
      ...(committedReplayManifest ? { manifest: committedReplayManifest } : {}),
    };
  }

  /**
   * `fromMs` (first batch only, without a cursor) starts the replay near that
   * time; `filter` keeps only one capture window's frames.
   */
  async readBatch(sessionId: string, cursor?: string, requestedLimit = 12, fromMs?: number, filter?: ReplayFrameFilter): Promise<EvidenceReplayBatch> {
    const { session, sessionPath, manifest } = await this.eligibleSession(sessionId);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_BATCH_FRAMES, Math.floor(requestedLimit)))
      : 12;
    const startOffset = decodeCursor(cursor, sessionId);
    const indexRelativePath = "spectrum/frames.jsonl";
    const indexEntry = manifest?.entries.get(indexRelativePath);
    if (manifest && session.frameCount > 0 && !indexEntry) {
      throw sourceInvalid("Complete evidence replay manifest does not contain its spectrum index");
    }
    let indexPath: string;
    try {
      indexPath = await assertNoSymlinkPath(sessionPath, indexRelativePath);
      if (manifest && !indexEntry) {
        throw sourceInvalid("Complete evidence replay contains an uncommitted spectrum index");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && session.frameCount === 0 && startOffset === 0 && !indexEntry) {
        return {
          schemaVersion: 1,
          sessionId,
          lifecycle: session.lifecycle as "Complete" | "Incomplete",
          evidenceGap: session.evidenceGap === true,
          incompleteReasons: [...(session.incompleteReasons ?? [])],
          frames: [],
          done: true,
        };
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sourceInvalid("Evidence replay spectrum index is missing");
      throw error;
    }

    const indexHandle = await openRegularNoFollow(indexPath, undefined, true);
    const rawHandles = new Map<string, { handle: FileHandle; verifiedIdentity?: FileIdentity }>();
    try {
      const verifiedIndexIdentity = indexEntry
        ? await this.verifyOpenManifestFile(
          indexHandle,
          sessionPath,
          indexRelativePath,
          indexEntry,
          MAX_REPLAY_INDEX_BYTES,
        )
        : undefined;
      const firstOffset = !cursor && fromMs !== undefined && Number.isFinite(fromMs)
        ? await seekIndexOffset(indexHandle, fromMs)
        : startOffset;
      const page = await readIndexRecords(indexHandle, firstOffset, limit, filter?.targetId || filter?.bandId ? filter : undefined);
      if (verifiedIndexIdentity) {
        await this.assertStillVerified(indexHandle, verifiedIndexIdentity, indexRelativePath);
      }
      const frames: EvidenceReplayFrame[] = [];
      for (const indexed of page.records) {
        let rawSource = rawHandles.get(indexed.rawFile);
        if (!rawSource) {
          const rawEntry = manifest?.entries.get(indexed.rawFile);
          if (manifest && !rawEntry) {
            throw sourceInvalid(`Complete evidence replay manifest does not contain ${indexed.rawFile}`);
          }
          const rawPath = await assertNoSymlinkPath(sessionPath, indexed.rawFile);
          const rawHandle = await openRegularNoFollow(rawPath, undefined, true);
          try {
            const verifiedIdentity = rawEntry
              ? await this.verifyOpenManifestFile(
                rawHandle,
                sessionPath,
                indexed.rawFile,
                rawEntry,
                MAX_REPLAY_RAW_BYTES,
              )
              : undefined;
            rawSource = { handle: rawHandle, ...(verifiedIdentity ? { verifiedIdentity } : {}) };
            rawHandles.set(indexed.rawFile, rawSource);
          } catch (error) {
            await rawHandle.close().catch(() => undefined);
            throw error;
          }
        }
        const details = await rawSource.handle.stat();
        if (indexed.rawOffset + indexed.rawLength > details.size) throw sourceInvalid("Evidence replay raw range is truncated");
        const bins = Buffer.allocUnsafe(indexed.rawLength);
        const read = await rawSource.handle.read(bins, 0, bins.byteLength, indexed.rawOffset);
        if (read.bytesRead !== bins.byteLength) throw sourceInvalid("Evidence replay raw range was truncated while reading");
        if (rawSource.verifiedIdentity) {
          await this.assertStillVerified(rawSource.handle, rawSource.verifiedIdentity, indexed.rawFile);
        }
        frames.push(replayFrame(indexed, bins, this.dataDomain));
      }
      const nextCursor = page.done
        ? undefined
        : encodeCursor({ v: 1, sessionId, byteOffset: page.nextOffset });
      return {
        schemaVersion: 1,
        sessionId,
        lifecycle: session.lifecycle as "Complete" | "Incomplete",
        evidenceGap: session.evidenceGap === true,
        incompleteReasons: [...(session.incompleteReasons ?? [])],
        frames,
        ...(nextCursor ? { nextCursor } : {}),
        done: page.done,
      };
    } finally {
      await indexHandle.close().catch(() => undefined);
      await Promise.all([...rawHandles.values()].map(({ handle }) => handle.close().catch(() => undefined)));
    }
  }
}
