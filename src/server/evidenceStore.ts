import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertRfOnlyDetectionClaim, rfVerdictFor } from "../shared/productContract";
import { incidentPackageBaseName, incidentReference } from "../shared/incidentNaming";
import { buildIncidentReportModel, type IncidentReportModel } from "./report/reportModel";
import { renderIncidentReportHtml } from "./report/reportHtml";
import { renderIncidentReportPdf } from "./report/reportPdf";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import type {
  AlertTriggerSnapshot,
  ReportIdentity,
  DetectionEvent,
  EvidenceManifest,
  EvidenceManifestEntry,
  EvidenceRetentionPolicy,
  EvidenceFinalizerHealth,
  EvidenceLifecycle,
  EvidenceSession,
  ConfigurationAuditEntry,
  PersistedSpectrumFrame,
  SpectrumFrame,
  StorageMaintenanceStatus,
  DataDomain,
  RuntimeIdentity,
  RecordingDeletionResult,
} from "../shared/types";
import { ensureDomainRoot } from "./dataDomains";
import { IncidentFigureBuilder, type IncidentFigureData, type IncidentFigureSummary } from "./incidentFigure";
import { IncidentReviewLog } from "./incidentReviews";
import type { AnalysisChartSet } from "./incidentAnalysis";
import {
  createEvidenceFinalizationRecord,
  inspectEvidenceCommitMetadata,
  legacyStatusForLifecycle,
  verifyEvidenceDirectory,
} from "./evidenceVerifier";
import {
  MAX_SCREENSHOT_PNG_BYTES,
  ScreenshotAdmissionController,
  scanPersistedScreenshotUsage,
  type PersistedScreenshotScanOptions,
  type ScreenshotAdmissionLease,
  type ScreenshotAdmissionOptions,
  type ScreenshotAdmissionResult,
  validateScreenshotPng,
} from "./screenshotAdmission";

interface SessionMetadata {
  config: unknown;
  sdrconnect: unknown;
}

export interface StorageMaintenanceReport extends StorageMaintenanceStatus {
  deletedSessionIds: string[];
  deletedExportFiles: string[];
}

interface CleanupCandidate {
  type: "session" | "export";
  id: string;
  absolutePath: string;
  bytes: number;
  timestamp: number;
  protected?: boolean;
}

interface RawChunkState {
  part: number;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  /** A failed rollback left the file longer than `bytes`; the next frame must start a new part. */
  poisoned?: boolean;
}

interface IncidentSliceSummary {
  frameCount: number;
  legacyFrameCount: number;
  rawBytes: number;
  startedAt: string;
  endedAt: string;
}

interface RecoveredJsonlTail {
  source: string;
  preservedAs: string;
  bytes: number;
}

type WriterPriority = "high" | "normal" | "low";

interface PendingWriterTask {
  priority: WriterPriority;
  enqueuedAt: number;
  estimatedBytes: number;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface PendingFinalizerTask {
  session: EvidenceSession;
  enqueuedAt: number;
  resolve: (session: EvidenceSession) => void;
}

export type EvidenceFinalizationFaultPoint = "hash" | "write" | "rename" | "fsync";
export type RecordingDeletionFaultPoint = "after-first-rename" | "after-commit" | "before-audit" | "before-cleanup";

/**
 * Process-kill boundaries used only by the packaged V2 qualification harness.
 * The production service cannot enable these points: the constructor requires
 * an explicit test acknowledgement and confines every related path to one
 * temporary sandbox below the host temporary directory.
 */
export type EvidenceProcessKillFaultPoint =
  | "frame-after-raw-append"
  | "frame-after-index-append"
  | "rotation-after-finalizing-checkpoint"
  | "rotation-after-next-session"
  | `finalization-${EvidenceFinalizationFaultPoint}`;

interface EvidenceProcessKillFaultController {
  point: EvidenceProcessKillFaultPoint;
  armFile: string;
  markerFile: string;
  triggered: boolean;
}

interface RecordingDeletionJournal {
  schemaVersion: 1;
  operationId: string;
  dataDomain: DataDomain;
  actor: string;
  requestedAt: string;
  phase: "prepared" | "committed" | "audited";
  sessionIds: string[];
  renamedSessionIds: string[];
  deletedBytes: number;
  retainedActiveSessions: number;
  retainedFinalizingSessions: number;
  retainedLeasedSessions: number;
}

export interface EvidenceStoreOptions {
  dataDomain?: DataDomain;
  /** Production default is fixed at 128 MiB; this override exists for bounded tests. */
  rawChunkMaxBytes?: number;
  incidentPrehistoryMs?: number;
  incidentPostClearMs?: number;
  /** Production is fixed at 256 MiB; smaller values support bounded tests. */
  exportPartMaxBytes?: number;
  /** A second folder, readable by a group of users, that also receives each incident's images and report. */
  shareDirectory?: string;
  /** Test-only fault boundary. Production leaves this unset. */
  finalizationFaultInjector?: (
    point: EvidenceFinalizationFaultPoint,
    sessionId: string,
  ) => void | Promise<void>;
  /** Test-only crash/fault boundary for protected recording deletion. */
  recordingDeletionFaultInjector?: (
    point: RecordingDeletionFaultPoint,
    operationId: string,
  ) => void | Promise<void>;
  /** Production is fixed at eight; smaller values support saturation tests. */
  finalizerMaxItems?: number;
  /** Production screenshot quotas are fixed; overrides support bounded tests. */
  screenshotAdmission?: ScreenshotAdmissionOptions;
  /** Traversal limits are test seams; production uses the fixed bounded scan. */
  screenshotScan?: Pick<PersistedScreenshotScanOptions, "maxSessions" | "maxEntries">;
}

export interface EvidenceInterruptionContext {
  cause: string;
  at?: string;
}

export interface IncidentExportContext {
  immutableExportId?: string;
  minimumFreeBytes?: number;
  baselineReference?: object;
  /** Site identity, report identity and logo for the client report. */
  report?: IncidentReportContext;
  /** Who asked for the export (network address), for the export record. */
  requester?: string;
}

/** Everything the client report needs that is not stored in the evidence itself. */
export interface IncidentReportContext {
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  reportIdentity?: ReportIdentity;
  logo?: { bytes: Uint8Array; mediaType: "image/png" | "image/jpeg" };
  serviceLabel?: string;
  runtimeIdentity?: unknown;
}

const INCIDENT_LOG_MARGIN_MS = 10 * 60_000;
const MAX_EXPORT_SCREENSHOTS = 32;

/** Per-request memo for incident lookups across sessions. */
export interface IncidentLookupCache {
  sessions?: Promise<EvidenceSession[]>;
  events: Map<string, Promise<DetectionEvent[]>>;
}

export class EvidenceCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceCorruptionError";
  }
}

export class EvidenceExportSourceError extends Error {
  constructor(
    readonly code:
      | "EVIDENCE_SOURCE_CORRUPT"
      | "EVIDENCE_SOURCE_FINALIZING"
      | "EVIDENCE_SOURCE_NOT_COMMITTED"
      | "EVIDENCE_SOURCE_INCOMPLETE_UNLABELLED"
      | "EVIDENCE_SOURCE_MANIFEST_MISSING"
      | "EVIDENCE_SOURCE_VERIFICATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceExportSourceError";
  }
}

export interface ExportableSessionDescriptor {
  sessionId: string;
  commitKey: string;
  estimatedOutputBytes: number;
}

export interface PrehistoryEvidenceFrame {
  frame: PersistedSpectrumFrame;
  summary: object;
}

const MAINTENANCE_LOG_LIMIT = 1024 * 1024;
const MAINTENANCE_LOG_TAIL = 512 * 1024;
const RECORDING_DELETE_JOURNAL = "recording-delete-operation.json";
const RECORDING_DELETE_AUDIT = "recording-delete-audit.jsonl";
const RECORDING_DELETE_AUDIT_LIMIT = 2 * 1024 * 1024;
const RECORDING_DELETE_AUDIT_TAIL = 1024 * 1024;
const SESSION_CHECKPOINT_INTERVAL_MS = 5_000;
export const RAW_CHUNK_MAX_BYTES = 128 * 1024 * 1024;
const INCIDENT_PREHISTORY_MS = 60_000;
const INCIDENT_POST_CLEAR_MS = 10 * 60_000;
const MAX_INDEX_LINE_BYTES = 1024 * 1024;
const MAX_STORED_FRAME_BINS = 2_048;
export const MAX_PREHISTORY_FRAMES = 240;
export const EXPORT_PART_MAX_BYTES = 256 * 1024 * 1024;
const MAX_WRITER_ITEMS = 64;
const MAX_WRITER_BYTES = 2 * 1024 * 1024;
/** Slice of the hard 64-item/2 MiB bound held back for session close and rotation. */
const WRITER_CRITICAL_RESERVE_ITEMS = 4;
const WRITER_CRITICAL_RESERVE_BYTES = 64 * 1024;
/** Ordinary writes are refused at these levels; only close/rotate may use the reserve. */
export const WRITER_ORDINARY_MAX_ITEMS = MAX_WRITER_ITEMS - WRITER_CRITICAL_RESERVE_ITEMS;
export const WRITER_ORDINARY_MAX_BYTES = MAX_WRITER_BYTES - WRITER_CRITICAL_RESERVE_BYTES;
const PREHISTORY_CHUNK_FRAMES = 32;
const STALE_EXPORT_STAGING_MS = 24 * 60 * 60_000;
export const MAX_FINALIZER_ITEMS = 8;
const PROCESS_KILL_FAULT_ACKNOWLEDGEMENT = "v2-qualification-only";
const PROCESS_KILL_FAULT_POINTS = new Set<EvidenceProcessKillFaultPoint>([
  "frame-after-raw-append",
  "frame-after-index-append",
  "rotation-after-finalizing-checkpoint",
  "rotation-after-next-session",
  "finalization-hash",
  "finalization-write",
  "finalization-rename",
  "finalization-fsync",
]);

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function processKillFaultController(root: string): EvidenceProcessKillFaultController | undefined {
  const configured = process.env.RF_MONITOR_TEST_PROCESS_FAULT_POINT?.trim();
  if (!configured) return undefined;
  if (
    process.env.NODE_ENV !== "test"
    || process.env.RF_MONITOR_ALLOW_TEST_PROCESS_FAULTS !== PROCESS_KILL_FAULT_ACKNOWLEDGEMENT
  ) {
    throw new Error("RF Monitor process-kill faults require the explicit V2 test-only acknowledgement");
  }
  if (!PROCESS_KILL_FAULT_POINTS.has(configured as EvidenceProcessKillFaultPoint)) {
    throw new Error(`Unknown RF Monitor process-kill fault point: ${configured}`);
  }
  const sandbox = path.resolve(process.env.RF_MONITOR_TEST_PROCESS_FAULT_ROOT ?? "");
  const armFile = path.resolve(process.env.RF_MONITOR_TEST_PROCESS_FAULT_ARM_FILE ?? "");
  const markerFile = path.resolve(process.env.RF_MONITOR_TEST_PROCESS_FAULT_MARKER_FILE ?? "");
  const temporaryRoot = realpathSync(os.tmpdir());
  let canonicalSandbox = "";
  let sandboxIsPrivate = false;
  try {
    const details = lstatSync(sandbox);
    canonicalSandbox = realpathSync(sandbox);
    sandboxIsPrivate = details.isDirectory()
      && !details.isSymbolicLink()
      && (typeof process.getuid !== "function" || details.uid === process.getuid())
      && (details.mode & 0o077) === 0;
  } catch {
    // A qualification sandbox is created before the packaged process starts.
    // Missing, linked, shared, or unowned roots are never eligible.
  }
  if (
    !sandboxIsPrivate
    || canonicalSandbox === path.parse(canonicalSandbox).root
    || !isPathInside(temporaryRoot, canonicalSandbox)
    || !isPathInside(canonicalSandbox, root)
    || !isPathInside(canonicalSandbox, armFile)
    || !isPathInside(canonicalSandbox, markerFile)
    || armFile === markerFile
  ) {
    throw new Error("RF Monitor process-kill fault paths must stay inside one temporary V2 sandbox");
  }
  return {
    point: configured as EvidenceProcessKillFaultPoint,
    armFile,
    markerFile,
    triggered: false,
  };
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-").replaceAll(".", "-");
}

interface IncidentFigureFiles {
  svg?: string;
  png?: Uint8Array;
  analysis?: AnalysisChartSet;
  data?: IncidentFigureData;
  summary: IncidentFigureSummary | { state: "unavailable"; reason: string };
}

function figureForReport(figure: IncidentFigureFiles) {
  return figure.analysis && figure.data && !("state" in figure.summary)
    ? { summary: figure.summary, analysis: figure.analysis, data: figure.data }
    : undefined;
}

const VERIFY_README = (reference: string) => `RF Monitor incident evidence package
${reference}

WHAT IS IN THIS PACKAGE
  report.pdf / report.html   Client report (same content). Start here.
  report.json                The report as data.
  incident.json              The incident record, including why the alert was raised.
  spectrum/                  The recorded spectrum frames: the evidence itself.
  evidence/                  Trigger snapshot, screenshots and operator notes.
  events/history.jsonl       Every stored version of this incident.
  logs/                      Operations, configuration and receiver logs for the incident window.
  source-context/            Receiver and configuration snapshots of each recording session.
  figures/                   Charts and images drawn from the recorded frames.
  export-record.json         When, where and by which software this package was made.
  manifest.json, SHA256SUMS.txt  SHA-256 hash of every file.

HOW TO CHECK THAT NOTHING CHANGED
Extract the ZIP, open a terminal in the extracted folder, then run:
  Linux:    sha256sum -c SHA256SUMS.txt
  macOS:    shasum -a 256 -c SHA256SUMS.txt
  Windows (PowerShell), for any file:
            Get-FileHash -Algorithm SHA256 .\report.pdf
            and compare the hash with the line for that file in SHA256SUMS.txt.
  RF Monitor host:  sudo rf-monitor verify-evidence <extracted folder>
Every line should report OK. A changed or missing file is reported as FAILED.

SCOPE
The hashes make any later change detectable. They are not a digital signature
and this package is not a certified legal chain of custody.
RF data can show interference, not intent. Levels are relative and uncalibrated.
`;

/** Automatic incident images: bounded in count and size no matter what retention is configured. */
const INCIDENT_FIGURE_DIRECTORY = "incident-figures";
const INCIDENT_FIGURE_MAX_FILES = 400;
const INCIDENT_FIGURE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const INCIDENT_FIGURE_NAME = /^(\d{8}T\d{6}Z)-(start|progress|end|final|refresh)(-analysis|-report)?\.(svg|png|html|json)$/;
export type IncidentFigureReason = "start" | "progress" | "end" | "final" | "refresh";

function figureStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function figureStampMs(stamp: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : Number.NaN;
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function syntheticExerciseMarkerError(value: unknown): string | undefined {
  if (!isRecord(value) || value.synthetic !== true) return "synthetic marker is invalid";
  const boundedIdentifier = (candidate: unknown): candidate is string =>
    typeof candidate === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(candidate);
  if (!boundedIdentifier(value.runId)) return "synthetic run ID is invalid";
  if (!boundedIdentifier(value.scenarioId)) return "synthetic scenario ID is invalid";
  if (!boundedIdentifier(value.scenarioVersion)) return "synthetic scenario version is invalid";
  if (typeof value.scenarioHash !== "string" || !/^[a-f0-9]{64}$/.test(value.scenarioHash)) {
    return "synthetic scenario hash is invalid";
  }
  if (!boundedIdentifier(value.validationProtocolVersion)) return "synthetic validation protocol version is invalid";
  if (!boundedIdentifier(value.generatorVersion)) return "synthetic generator version is invalid";
  return undefined;
}

function isEvidenceLifecycle(value: unknown): value is EvidenceLifecycle {
  return value === "Active" || value === "Finalizing" || value === "Complete" || value === "Incomplete" || value === "Corrupt";
}

function detectorAnalysisError(frame: Record<string, unknown>, storedBinCount: number): string | undefined {
  if (frame.detectorAnalysis === undefined) return undefined;
  const analysis = frame.detectorAnalysis;
  if (!isRecord(analysis)
    || analysis.schemaVersion !== 1
    || analysis.source !== "relative-mad-detector"
    || typeof analysis.observationId !== "string" || !analysis.observationId.trim()
    || typeof analysis.ruleSetId !== "string" || !analysis.ruleSetId.trim()
    || !["unknown", "clean", "anomalous"].includes(String(analysis.disposition))
    || typeof analysis.baselineAvailable !== "boolean"
    || typeof analysis.overload !== "boolean") return "detector analysis header is invalid";
  const startBin = analysis.analysisStartBin;
  const endBin = analysis.analysisEndBin;
  if (!Number.isSafeInteger(startBin) || !Number.isSafeInteger(endBin)
    || (startBin as number) < 0 || (endBin as number) <= (startBin as number)
    || (endBin as number) > storedBinCount
    || startBin !== frame.analysisStartBin || endBin !== frame.analysisEndBin) return "detector analysis grid does not match the evidence frame";
  if (!Number.isFinite(Number(frame.startHz)) || !Number.isFinite(Number(frame.endHz)) || Number(frame.endHz) <= Number(frame.startHz)
    || !Array.isArray(analysis.analyzedRangeHz) || analysis.analyzedRangeHz.length !== 2
    || !analysis.analyzedRangeHz.every((value) => Number.isFinite(value))
    || (analysis.analyzedRangeHz[1] as number) <= (analysis.analyzedRangeHz[0] as number)
    || (analysis.analyzedRangeHz[0] as number) < Number(frame.startHz)
    || (analysis.analyzedRangeHz[1] as number) > Number(frame.endHz)) return "detector analyzed frequency range is invalid";
  if (!Array.isArray(analysis.anomalyBinRanges)) return "detector anomaly ranges are invalid";
  if (analysis.anomalyKind !== undefined && !["wideband-noise-rise", "narrowband-spike", "baseline-drift"].includes(String(analysis.anomalyKind))) {
    return "detector anomaly kind is invalid";
  }
  if (analysis.anomalyDetailKind !== undefined && (
    !["wideband", "partial-band", "narrowband", "noise-floor", "burst"].includes(String(analysis.anomalyDetailKind))
    || analysis.anomalyKind === undefined
  )) return "detector anomaly detail is invalid";
  if (analysis.referenceRevision !== undefined && (typeof analysis.referenceRevision !== "string" || analysis.referenceRevision.length > 160)) {
    return "detector reference revision is invalid";
  }
  for (const range of analysis.anomalyBinRanges) {
    if (!isRecord(range) || !Number.isSafeInteger(range.startBin) || !Number.isSafeInteger(range.endBin)
      || (range.startBin as number) < (startBin as number) || (range.endBin as number) <= (range.startBin as number)
      || (range.endBin as number) > (endBin as number)) return "detector anomaly range escapes the analyzed grid";
  }
  if (analysis.overload === true && (analysis.anomalyBinRanges.length > 0 || analysis.anomalyKind !== undefined)) {
    return "receiver overload cannot carry RF anomaly ranges";
  }
  if (analysis.overload === true && analysis.disposition !== "anomalous") return "receiver overload requires an anomalous disposition";
  if (analysis.anomalyBinRanges.length > 0 && analysis.anomalyKind === undefined) return "detector anomaly ranges require an anomaly kind";
  if (analysis.anomalyBinRanges.length > 0 && analysis.disposition !== "anomalous") {
    return "detector anomaly ranges require an anomalous disposition";
  }
  return undefined;
}

function validatedRuntimeIdentity(value: unknown): RuntimeIdentity | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.release) || !isRecord(value.configuration)) return undefined;
  const release = value.release;
  const configuration = value.configuration;
  if (
    typeof value.serviceBootId !== "string" || value.serviceBootId.length > 128
    || typeof value.serviceStartedAt !== "string" || !Number.isFinite(Date.parse(value.serviceStartedAt))
    || release.product !== "rf-monitor"
    || typeof release.buildId !== "string" || release.buildId.length > 128
    || ![release.sourceDigest, release.packageDigest, release.dependencyLockDigest].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
    || typeof configuration.configurationHash !== "string" || !/^[a-f0-9]{64}$/.test(configuration.configurationHash)
  ) return undefined;
  return structuredClone(value) as unknown as RuntimeIdentity;
}

async function runtimeIdentityFromEvidenceRoot(root: string): Promise<RuntimeIdentity | undefined> {
  const candidates = [path.join(root, "config.json")];
  try {
    // Incident packages keep each session's configuration under source-context/.
    const index = JSON.parse(await readFile(path.join(root, "source-context", "index.json"), "utf8")) as { sessions?: Array<{ config?: string }> };
    for (const session of index.sessions ?? []) if (typeof session.config === "string") candidates.push(path.join(root, ...session.config.split("/")));
  } catch {
    // Session packages have no source-context index.
  }
  for (const candidate of candidates) {
    try {
      const config = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      const identity = isRecord(config) ? validatedRuntimeIdentity(config.runtimeIdentity) : undefined;
      if (identity) return identity;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  const pending = [current];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(path.relative(root, entryPath));
    }
  }
  return files;
}

async function* boundedJsonlRecords<T>(
  filePath: string,
  label: string,
  allowFinalUnterminated: boolean,
): AsyncGenerator<T> {
  const details = await stat(filePath);
  if (details.size === 0) return;
  const handle = await open(filePath, "r");
  let finalByte = Buffer.alloc(1);
  try {
    await handle.read(finalByte, 0, 1, details.size - 1);
  } finally {
    await handle.close();
  }
  const endsWithNewline = finalByte[0] === 0x0a;
  const lines = createInterface({
    input: createReadStream(filePath, { start: 0, end: details.size - 1 }),
    crlfDelay: Infinity,
  });
  let pending: { line: string; lineNumber: number } | undefined;
  let lineNumber = 0;
  const parse = (entry: { line: string; lineNumber: number }, final: boolean): T | undefined => {
    if (Buffer.byteLength(entry.line) > MAX_INDEX_LINE_BYTES) {
      throw new EvidenceCorruptionError(`${label} line ${entry.lineNumber} exceeds the resource bound`);
    }
    if (!entry.line.trim()) return undefined;
    // A JSONL record is committed only by its terminating newline. A final
    // unterminated record in an active session is indeterminate even when its
    // bytes happen to form valid JSON; restart recovery quarantines it.
    if (final && allowFinalUnterminated && !endsWithNewline) return undefined;
    try {
      return JSON.parse(entry.line) as T;
    } catch {
      throw new EvidenceCorruptionError(`${label} contains malformed JSON at line ${entry.lineNumber}`);
    }
  };
  for await (const line of lines) {
    lineNumber += 1;
    if (pending) {
      const parsed = parse(pending, false);
      if (parsed !== undefined) yield parsed;
    }
    pending = { line, lineNumber };
  }
  if (pending) {
    const parsed = parse(pending, true);
    if (parsed !== undefined) yield parsed;
  }
}

function archivePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}


function safeEvidenceString(value: string): string {
  return value
    .replace(/spoof(?:ing|ed)?/gi, "navigation anomaly")
    .replace(/\bd\s*b\s*m\b/gi, "relative units")
    .replace(/confidence/gi, "evidence strength");
}

function sanitizeEvidence(value: unknown, key = ""): unknown {
  if (/confidence|dbm/i.test(key)) return undefined;
  if (typeof value === "string") {
    if (key === "kind" && /spoof/i.test(value)) return "gnss-energy-anomaly";
    return safeEvidenceString(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  if (value instanceof Uint8Array) return undefined;
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeEvidence(child, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}


async function writeAtomic(filePath: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeAtomicUnflushed(filePath: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o640 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class EvidenceStore {
  private active?: EvidenceSession;
  private readonly writerTasks: PendingWriterTask[] = [];
  private activeWriterTask?: PendingWriterTask;
  private writerDraining = false;
  private readonly writerIdleWaiters: Array<() => void> = [];
  private readonly rawChunksByHour = new Map<string, RawChunkState>();
  private lastSessionCheckpointAt = 0;
  private readonly rawChunkMaxBytes: number;
  private readonly incidentPrehistoryMs: number;
  private readonly incidentPostClearMs: number;
  private readonly exportPartMaxBytes: number;
  private readonly shareDirectory?: string;
  private shareFailureLoggedAt = 0;
  private readonly exportSourceSessionLeases = new Map<string, number>();
  private readonly exportPathLeases = new Map<string, number>();
  private readonly activeExportPrefixes = new Map<string, number>();
  private readonly finalizerTasks: PendingFinalizerTask[] = [];
  private activeFinalizerTask?: PendingFinalizerTask;
  private finalizerDraining = false;
  private readonly finalizerIdleWaiters: Array<() => void> = [];
  private readonly finalizerMaxItems: number;
  private readonly finalizationFaultInjector?: EvidenceStoreOptions["finalizationFaultInjector"];
  private finalizerCompletedTotal = 0;
  private finalizerIncompleteTotal = 0;
  private finalizerCorruptTotal = 0;
  private finalizerRejectedTotal = 0;
  private finalizerLastFailure?: EvidenceFinalizerHealth["lastFailure"];
  private recordingDeletionActive = false;
  private activeExportOperations = 0;
  private readonly recordingDeletionFaultInjector?: EvidenceStoreOptions["recordingDeletionFaultInjector"];
  private readonly processKillFault?: EvidenceProcessKillFaultController;
  private readonly screenshotAdmission: ScreenshotAdmissionController;
  private readonly screenshotScan?: EvidenceStoreOptions["screenshotScan"];
  private screenshotQuotaReady = false;
  private screenshotQuotaFailure?: string;
  readonly dataDomain: DataDomain;
  /** Notes and review marks added after an incident's sessions were finalized. */
  readonly reviews: IncidentReviewLog;

  constructor(readonly root: string, options: EvidenceStoreOptions = {}) {
    this.dataDomain = options.dataDomain ?? "field";
    this.reviews = new IncidentReviewLog(root, this.dataDomain);
    this.rawChunkMaxBytes = options.rawChunkMaxBytes ?? RAW_CHUNK_MAX_BYTES;
    this.incidentPrehistoryMs = options.incidentPrehistoryMs ?? INCIDENT_PREHISTORY_MS;
    this.incidentPostClearMs = options.incidentPostClearMs ?? INCIDENT_POST_CLEAR_MS;
    this.exportPartMaxBytes = options.exportPartMaxBytes ?? EXPORT_PART_MAX_BYTES;
    this.shareDirectory = options.shareDirectory;
    this.finalizerMaxItems = options.finalizerMaxItems ?? MAX_FINALIZER_ITEMS;
    this.finalizationFaultInjector = options.finalizationFaultInjector;
    this.recordingDeletionFaultInjector = options.recordingDeletionFaultInjector;
    this.processKillFault = processKillFaultController(this.root);
    this.screenshotAdmission = new ScreenshotAdmissionController(options.screenshotAdmission);
    this.screenshotScan = options.screenshotScan;
    if (!Number.isSafeInteger(this.rawChunkMaxBytes) || this.rawChunkMaxBytes <= 0 || this.rawChunkMaxBytes > RAW_CHUNK_MAX_BYTES) {
      throw new Error(`rawChunkMaxBytes must be an integer between 1 and ${RAW_CHUNK_MAX_BYTES}`);
    }
    if (!Number.isSafeInteger(this.incidentPrehistoryMs) || this.incidentPrehistoryMs < 0) throw new Error("incidentPrehistoryMs must be a non-negative integer");
    if (!Number.isSafeInteger(this.incidentPostClearMs) || this.incidentPostClearMs < 0) throw new Error("incidentPostClearMs must be a non-negative integer");
    if (!Number.isSafeInteger(this.exportPartMaxBytes) || this.exportPartMaxBytes < 16 * 1024 || this.exportPartMaxBytes > EXPORT_PART_MAX_BYTES) {
      throw new Error(`exportPartMaxBytes must be between 16384 and ${EXPORT_PART_MAX_BYTES}`);
    }
    if (!Number.isSafeInteger(this.finalizerMaxItems) || this.finalizerMaxItems < 1 || this.finalizerMaxItems > MAX_FINALIZER_ITEMS) {
      throw new Error(`finalizerMaxItems must be between 1 and ${MAX_FINALIZER_ITEMS}`);
    }
    const exportOverheadReserve = Math.min(1024 * 1024, Math.floor(this.exportPartMaxBytes * 0.35));
    if (this.rawChunkMaxBytes >= this.exportPartMaxBytes - exportOverheadReserve) {
      throw new Error("rawChunkMaxBytes must leave room inside the configured multipart export bound");
    }
  }

  get currentSession(): EvidenceSession | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  getScreenshotQuotaHealth(): { ready: boolean; failure?: string; count: number; bytes: number } {
    return {
      ready: this.screenshotQuotaReady,
      ...(this.screenshotQuotaFailure ? { failure: this.screenshotQuotaFailure } : {}),
      ...this.screenshotAdmission.committedUsage,
    };
  }

  reserveScreenshot(eventId: string, expectedBytes: number): ScreenshotAdmissionResult | undefined {
    if (!this.screenshotQuotaReady) return undefined;
    return this.screenshotAdmission.reserve(eventId, expectedBytes);
  }

  protectExportArtifacts(paths: readonly string[], protect: boolean): void {
    for (const artifactPath of paths) {
      const resolved = path.resolve(artifactPath);
      this.assertContained(resolved);
      const relative = path.relative(path.join(this.root, "exports"), resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Export artifact is outside the exports directory");
      this.updateLease(this.exportPathLeases, resolved, protect ? 1 : -1);
    }
  }

  async discardExportArtifacts(paths: readonly string[]): Promise<void> {
    for (const artifactPath of paths) {
      const resolved = path.resolve(artifactPath);
      this.assertContained(resolved);
      const relative = path.relative(path.join(this.root, "exports"), resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Export artifact is outside the exports directory");
      this.updateLease(this.exportPathLeases, resolved, -1);
      await rm(resolved, { force: true });
    }
  }

  getWriterHealth(now = Date.now()): { queueItems: number; queueBytes: number; oldestAgeMs: number } {
    const tasks = [...(this.activeWriterTask ? [this.activeWriterTask] : []), ...this.writerTasks];
    return {
      queueItems: tasks.length,
      queueBytes: tasks.reduce((total, task) => total + task.estimatedBytes, 0),
      oldestAgeMs: tasks.length ? Math.max(0, now - Math.min(...tasks.map((task) => task.enqueuedAt))) : 0,
    };
  }

  getFinalizerHealth(now = Date.now()): EvidenceFinalizerHealth {
    const tasks = [...(this.activeFinalizerTask ? [this.activeFinalizerTask] : []), ...this.finalizerTasks];
    return {
      queueItems: tasks.length,
      queueLimit: this.finalizerMaxItems,
      oldestAgeMs: tasks.length ? Math.max(0, now - Math.min(...tasks.map((task) => task.enqueuedAt))) : 0,
      ...(this.activeFinalizerTask ? { activeSessionId: this.activeFinalizerTask.session.id } : {}),
      completedTotal: this.finalizerCompletedTotal,
      incompleteTotal: this.finalizerIncompleteTotal,
      corruptTotal: this.finalizerCorruptTotal,
      rejectedTotal: this.finalizerRejectedTotal,
      ...(this.finalizerLastFailure ? { lastFailure: { ...this.finalizerLastFailure } } : {}),
    };
  }

  /**
   * Wait until every writer job accepted before (or while) this call is waiting
   * has settled. Callers that need a stable boundary must stop their producers
   * before awaiting this method. The barrier itself is not a priority-queued
   * job, so a close/rotation cannot overtake older lower-priority writes.
   */
  async flush(): Promise<void> {
    if (!this.activeWriterTask && !this.writerTasks.length && !this.writerDraining) return;
    await new Promise<void>((resolve) => this.writerIdleWaiters.push(resolve));
  }

  async flushFinalizers(): Promise<void> {
    if (!this.activeFinalizerTask && !this.finalizerTasks.length && !this.finalizerDraining) return;
    await new Promise<void>((resolve) => this.finalizerIdleWaiters.push(resolve));
  }

  shouldRotate(maxBytes: number, maxAgeMs: number, now = Date.now()): boolean {
    if (!this.active) return false;
    return this.active.byteCount >= maxBytes || now - Date.parse(this.active.startedAt) >= maxAgeMs;
  }

  async initialize(metadata: SessionMetadata, interruption?: EvidenceInterruptionContext): Promise<EvidenceSession> {
    await ensureDomainRoot(this.root, this.dataDomain);
    if (this.active) throw new Error("An evidence session is already active");
    await this.recoverRecordingDeletion();
    await this.recoverPartialExports();
    await this.recoverInterruptedSessions(interruption);
    await this.loadPersistedScreenshotQuota();
    return this.createSession(metadata);
  }

  private async createSession(metadata: SessionMetadata): Promise<EvidenceSession> {
    const startedAt = new Date().toISOString();
    const id = `session-${safeTimestamp(startedAt)}-${randomUUID().slice(0, 8)}`;
    const sessionPath = this.pathForSession(id);
    await Promise.all([
      mkdir(path.join(sessionPath, "events"), { recursive: true }),
      mkdir(path.join(sessionPath, "spectrum", "raw"), { recursive: true }),
      mkdir(path.join(sessionPath, "screenshots"), { recursive: true }),
      mkdir(path.join(sessionPath, "notes"), { recursive: true }),
      mkdir(path.join(this.root, "exports"), { recursive: true }),
    ]);
    const configContents = JSON.stringify(sanitizeEvidence(metadata.config), null, 2);
    const sdrconnectContents = JSON.stringify(sanitizeEvidence(metadata.sdrconnect), null, 2);
    this.active = {
      id,
      dataDomain: this.dataDomain,
      startedAt,
      path: sessionPath,
      lifecycle: "Active",
      verification: { outcome: "not-run" },
      status: "recording",
      frameCount: 0,
      eventCount: 0,
      byteCount: Buffer.byteLength(configContents) + Buffer.byteLength(sdrconnectContents),
    };
    this.rawChunksByHour.clear();
    this.frameIndexNeedsRepair = false;
    this.lastSessionCheckpointAt = Date.now();
    await Promise.all([
      writeAtomic(path.join(sessionPath, "config.json"), configContents),
      writeAtomic(path.join(sessionPath, "sdrconnect.json"), sdrconnectContents),
      this.persistSession(this.active),
    ]);
    return { ...this.active };
  }

  async rotate(metadata: SessionMetadata): Promise<EvidenceSession> {
    const rotation = await this.enqueue(async () => {
      const previous = this.requireActive();
      await this.prepareFinalizing(previous);
      this.injectProcessKillFault("rotation-after-finalizing-checkpoint", previous.id);
      this.active = undefined;
      const next = await this.createSession(metadata);
      this.injectProcessKillFault("rotation-after-next-session", previous.id);
      const finalization = this.scheduleFinalization({ ...previous });
      if (!finalization) await this.markFinalizationRejected(previous);
      return { next };
    }, 16 * 1024, "high", true);
    return rotation.next;
  }

  async closeActive(): Promise<EvidenceSession> {
    const transition = await this.enqueue(async () => {
      const session = this.requireActive();
      await this.prepareFinalizing(session);
      this.active = undefined;
      const finalization = this.scheduleFinalization({ ...session });
      if (!finalization) {
        await this.markFinalizationRejected(session);
        return { session: { ...session } };
      }
      return { session: { ...session }, finalization };
    }, 16 * 1024, "high", true);
    return transition.finalization ?? transition.session;
  }

  recordFrame(frame: PersistedSpectrumFrame, summary: object): Promise<void> {
    try {
      this.validateSyntheticEvidenceBoundary(frame.syntheticExercise, frame.dataDomain, frame.source);
      this.validatePersistedFrame(frame);
    } catch (error) {
      return Promise.reject(error);
    }
    const storedFrame = structuredClone(frame);
    const storedSummary = structuredClone(summary);
    return this.enqueue(() => this.appendFrame(storedFrame, storedSummary), storedFrame.bins.byteLength + 4 * 1024, "high");
  }

  async recordPrehistory(frames: readonly PrehistoryEvidenceFrame[]): Promise<void> {
    if (!Array.isArray(frames) || frames.length > MAX_PREHISTORY_FRAMES) {
      throw new Error(`Prehistory batch cannot exceed ${MAX_PREHISTORY_FRAMES} frames`);
    }
    if (frames.some((item) => item.frame.syntheticExercise)) {
      throw new Error("Synthetic exercise frames cannot enter operational evidence");
    }
    // Freeze the caller's buffers and metadata before the work enters the
    // priority queue. A candidate can remain active while the live receiver
    // continues updating its ring, so retaining caller-owned views would make
    // the evidence non-deterministic.
    const storedFrames = frames.map((item) => ({
      frame: structuredClone(item.frame),
      summary: structuredClone(item.summary),
    }));
    for (let start = 0; start < storedFrames.length; start += PREHISTORY_CHUNK_FRAMES) {
      const chunk = storedFrames.slice(start, start + PREHISTORY_CHUNK_FRAMES);
      const estimatedBytes = chunk.reduce((total, item) => total + item.frame.bins.byteLength + 4 * 1024, 0);
      await this.enqueue(() => this.appendPrehistoryChunk(chunk), estimatedBytes, "normal");
    }
  }

  recordEvent(event: DetectionEvent, destinationSessionId?: string, baselineReference?: object): Promise<void> {
    try {
      this.validateSyntheticEvidenceBoundary(event.syntheticExercise, event.dataDomain);
    } catch (error) {
      return Promise.reject(error);
    }
    if (event.dataDomain !== this.dataDomain) {
      return Promise.reject(new Error(`Evidence event belongs to ${event.dataDomain ?? "unscoped"} data, not ${this.dataDomain}`));
    }
    try {
      assertRfOnlyDetectionClaim(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const storedEvent = structuredClone(event);
    const storedBaselineReference = baselineReference ? structuredClone(baselineReference) : undefined;
    return this.enqueue(async () => {
      const sessionIds = [...new Set([storedEvent.sessionId, ...(storedEvent.sessionIds ?? [])])];
      const selectedSessionId = destinationSessionId
        ?? (this.active && sessionIds.includes(this.active.id) ? this.active.id : storedEvent.sessionId);
      let session = await this.sessionForId(selectedSessionId);
      if (session.lifecycle !== "Active" && session.status !== "recording") {
        if (!this.active) throw new Error(`Evidence session ${session.id} is immutable after finalization starts`);
        session = { ...this.active };
        sessionIds.push(session.id);
      }
      if (storedBaselineReference) {
        const baselinePath = path.join(session.path, "events", "baselines", `${safeIdentifier(storedEvent.id, "event id")}.json`);
        session.byteCount += await this.writeImmutableJson(baselinePath, storedBaselineReference, `Baseline reference for ${storedEvent.id}`);
      }
      const line = `${JSON.stringify(sanitizeEvidence({ ...storedEvent, sessionIds }))}\n`;
      await appendFile(path.join(session.path, "events", "events.jsonl"), line);
      session.eventCount += 1;
      session.byteCount += Buffer.byteLength(line);
      await this.checkpointSession(session, true);
      this.refreshActive(session);
    }, 16 * 1024, "high");
  }

  /**
   * Store exactly what the detector compared when an incident was first
   * raised. Written once per incident; hex arrays survive evidence sanitising.
   */
  recordTriggerSnapshot(sessionId: string, snapshot: AlertTriggerSnapshot): Promise<void> {
    if (snapshot.dataDomain !== this.dataDomain) {
      return Promise.reject(new Error(`Trigger snapshot belongs to ${snapshot.dataDomain} data, not ${this.dataDomain}`));
    }
    const stored = structuredClone(snapshot);
    return this.enqueue(async () => {
      let session = await this.sessionForId(sessionId);
      if (session.lifecycle !== "Active" && session.status !== "recording") {
        if (!this.active) throw new Error(`Evidence session ${session.id} is immutable after finalization starts`);
        session = { ...this.active };
      }
      const snapshotPath = path.join(session.path, "events", "triggers", `${safeIdentifier(stored.eventId, "event id")}.json`);
      session.byteCount += await this.writeImmutableJson(snapshotPath, stored, `Trigger snapshot for ${stored.eventId}`);
      await this.checkpointSession(session, true);
      this.refreshActive(session);
    }, 32 * 1024, "high");
  }

  /** The stored trigger snapshot for an incident, searched across its sessions. */
  async readTriggerSnapshot(eventId: string, sessionIds: string[]): Promise<AlertTriggerSnapshot | undefined> {
    const fileName = `${safeIdentifier(eventId, "event id")}.json`;
    for (const sessionId of [...new Set(sessionIds)]) {
      let session;
      try {
        session = await this.sessionForId(sessionId);
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(path.join(session.path, "events", "triggers", fileName), "utf8")) as AlertTriggerSnapshot;
        if (parsed?.schemaVersion === 1 && parsed.eventId === eventId && parsed.dataDomain === this.dataDomain) return parsed;
      } catch {
        // Older incidents have no trigger snapshot.
      }
    }
    return undefined;
  }

  private async writeImmutableJson(filePath: string, value: object, label: string): Promise<number> {
    const payload = JSON.stringify(sanitizeEvidence(value), null, 2);
    await mkdir(path.dirname(filePath), { recursive: true });
    let handle;
    try {
      handle = await open(filePath, "wx", 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(filePath, "utf8");
      if (existing !== payload) throw new EvidenceCorruptionError(`${label} conflicts with its immutable stored snapshot`);
      return 0;
    }
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Buffer.byteLength(payload);
  }

  recordMetadata(receiver: number, metadata: object): Promise<void> {
    return this.enqueue(async () => {
      const session = this.requireActive();
      const line = `${JSON.stringify(sanitizeEvidence({ timestamp: new Date().toISOString(), receiver, ...metadata }))}\n`;
      await appendFile(path.join(session.path, "sdrconnect-events.jsonl"), line);
      session.byteCount += Buffer.byteLength(line);
      await this.checkpointSession(session);
    }, 8 * 1024, "normal");
  }

  updateSdrconnectContext(context: object): Promise<void> {
    return this.enqueue(async () => {
      const session = this.requireActive();
      const contextPath = path.join(session.path, "sdrconnect.json");
      const previousBytes = await stat(contextPath).then((details) => details.size).catch(() => 0);
      const contents = JSON.stringify(sanitizeEvidence(context), null, 2);
      await writeAtomic(contextPath, contents);
      session.byteCount = Math.max(0, session.byteCount - previousBytes + Buffer.byteLength(contents));
      await this.checkpointSession(session);
    }, 32 * 1024, "high");
  }

  recordOperationalAction(action: object): Promise<void> {
    try {
      const record = isRecord(action) ? action : undefined;
      if (record?.syntheticExercise !== undefined) {
        this.validateSyntheticEvidenceBoundary(record.syntheticExercise, record.dataDomain);
      }
      if (record?.dataDomain !== undefined && record.dataDomain !== this.dataDomain) {
        throw new Error(`Evidence operation belongs to ${String(record.dataDomain)} data, not ${this.dataDomain}`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const storedAction = structuredClone(action);
    return this.enqueue(async () => {
      const session = this.requireActive();
      const line = `${JSON.stringify(sanitizeEvidence({ timestamp: new Date().toISOString(), ...storedAction, dataDomain: this.dataDomain }))}\n`;
      await appendFile(path.join(session.path, "operations.jsonl"), line);
      session.byteCount += Buffer.byteLength(line);
      await this.checkpointSession(session);
    }, 8 * 1024, "high");
  }

  recordConfigurationAudit(entry: ConfigurationAuditEntry): Promise<void> {
    return this.enqueue(async () => {
      const session = this.requireActive();
      const line = `${JSON.stringify(sanitizeEvidence(entry))}\n`;
      await appendFile(path.join(session.path, "configuration-audit.jsonl"), line);
      session.byteCount += Buffer.byteLength(line);
      await this.checkpointSession(session);
    }, 8 * 1024, "normal");
  }

  async recordScreenshot(
    sessionId: string,
    eventId: string,
    png: Buffer,
    admittedLease?: ScreenshotAdmissionLease,
  ): Promise<string> {
    validateScreenshotPng(png);
    if (png.byteLength + 4 * 1024 > 2 * 1024 * 1024 || png.byteLength > MAX_SCREENSHOT_PNG_BYTES) {
      throw new Error("Screenshot exceeds the 2 MiB evidence writer bound");
    }
    const safeEventId = safeIdentifier(eventId, "event id");
    const admission = admittedLease
      ? { admitted: true as const, lease: admittedLease }
      : this.reserveScreenshot(safeEventId, png.byteLength);
    if (!admission) throw new Error("Screenshot quota is unavailable until persisted evidence has been inspected");
    if (!admission.admitted) throw new Error(`Screenshot ${admission.reason} quota reached`);
    if (admission.lease.eventId !== safeEventId || png.byteLength > admission.lease.reservedBytes) {
      admission.lease.release();
      throw new Error("Screenshot body does not match its admission lease");
    }
    try {
      return await this.enqueue(async () => {
        let session = await this.sessionForId(sessionId);
        if (session.lifecycle !== "Active" && session.status !== "recording") {
          if (!this.active) throw new Error(`Evidence session ${session.id} is immutable after finalization starts`);
          session = { ...this.active };
        }
        const eventDirectory = path.join(session.path, "screenshots", safeEventId);
        await mkdir(eventDirectory, { recursive: true });
        const eventDirectoryDetails = await lstat(eventDirectory);
        if (!eventDirectoryDetails.isDirectory() || eventDirectoryDetails.isSymbolicLink()) {
          throw new Error("Screenshot event destination is not a regular evidence directory");
        }
        const filename = `${safeTimestamp(new Date().toISOString())}-${randomUUID().slice(0, 8)}.png`;
        await writeFile(path.join(eventDirectory, filename), png, { flag: "wx", mode: 0o640 });
        // Commit immediately after the file is created. If a later session
        // checkpoint fails, the on-disk image is still charged in this process
        // and will be reconstructed on restart.
        admission.lease.commit(png.byteLength);
        session.byteCount += png.byteLength;
        await this.persistSession(session);
        this.refreshActive(session);
        return path.posix.join(safeEventId, filename);
      }, png.byteLength + 4 * 1024, "low");
    } catch (error) {
      admission.lease.release();
      throw error;
    }
  }

  addNote(sessionId: string, eventId: string, text: string): Promise<string> {
    return this.enqueue(async () => {
      let session = await this.sessionForId(sessionId);
      if (session.lifecycle !== "Active" && session.status !== "recording") {
        if (!this.active) throw new Error(`Evidence session ${session.id} is immutable after finalization starts`);
        session = { ...this.active };
      }
      const timestamp = new Date().toISOString();
      const safeEventId = safeIdentifier(eventId, "event id");
      const filename = `${safeTimestamp(timestamp)}-${safeEventId}.json`;
      const payload = JSON.stringify(sanitizeEvidence({ eventId: safeEventId, timestamp, text }), null, 2);
      await writeFile(path.join(session.path, "notes", filename), payload);
      session.byteCount += Buffer.byteLength(payload);
      await this.persistSession(session);
      this.refreshActive(session);
      return filename;
    }, Buffer.byteLength(text) + 4 * 1024, "normal");
  }

  createManifest(sessionId?: string): Promise<EvidenceManifest> {
    return this.enqueue(async () => {
      const session = sessionId ? await this.sessionForId(sessionId) : this.requireActive();
      if (session.lifecycle === "Complete" || session.lifecycle === "Incomplete") {
        const verification = await verifyEvidenceDirectory(session.path, { expectedDataDomain: this.dataDomain });
        if (verification.outcome === "FAIL") {
          throw new EvidenceCorruptionError(`Evidence session ${session.id} failed verification: ${verification.reasons.join(",")}`);
        }
        return JSON.parse(await readFile(path.join(session.path, "manifest.json"), "utf8")) as EvidenceManifest;
      }
      if (session.lifecycle === "Finalizing") throw new Error(`Evidence session ${session.id} is still finalizing`);
      if (session.lifecycle === "Corrupt") throw new EvidenceCorruptionError(`Evidence session ${session.id} is corrupt`);
      await this.persistSession(session);
      return this.createManifestForSession(session);
    }, 64 * 1024, "low");
  }

  async exportIncident(event: DetectionEvent, context: IncidentExportContext = {}): Promise<string | string[]> {
    if (this.recordingDeletionActive) throw new Error("Recording deletion is in progress; retry after it completes");
    this.activeExportOperations += 1;
    try {
      const storedEvent = await this.findIncidentEvent(event.id, event.sessionId);
      // Notes and review added after the session closed travel with the package and report.
      const exportEvent = await this.reviews.apply(storedEvent ?? event);
      const requestedSessionIds = [...new Set([exportEvent.sessionId, ...(exportEvent.sessionIds ?? [])])];
      for (const sessionId of requestedSessionIds) this.updateLease(this.exportSourceSessionLeases, sessionId, 1);
      let stagingPath: string | undefined;
      let outputPrefix: string | undefined;
      try {
      const sessions: EvidenceSession[] = [];
      const missingSessionIds: string[] = [];
      for (const sessionId of requestedSessionIds) {
        try {
          sessions.push(await this.sessionForId(sessionId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missingSessionIds.push(sessionId);
          else throw error;
        }
      }
      if (!sessions.length) throw new Error("No surviving evidence session is available for this incident");
      for (const candidate of sessions) await this.assertExportableSource(candidate);
      await this.ensureExportScratch(
        sessions.reduce((total, candidate) => total + candidate.byteCount, 0),
        context.minimumFreeBytes ?? 0,
      );
      const session = sessions[0];
      const eventId = safeIdentifier(exportEvent.id, "event id");
      const baselineReference = await this.resolveIncidentBaselineReference(sessions, exportEvent, context.baselineReference);
      const incompleteSourceSessionIds = sessions.filter((candidate) => candidate.evidenceGap).map((candidate) => candidate.id);
      // Legacy manifest-v1 events did not carry a baseline generation. Preserve
      // their readability, but every new generation-pinned event must include
      // the exact immutable snapshot or advertise an explicit evidence gap.
      const missingBaselineReference = this.expectedBaselineGeneration(exportEvent) !== undefined && !baselineReference;
      const missingParts = [
        ...missingSessionIds,
        ...incompleteSourceSessionIds.map((sessionId) => `${sessionId}:recovery-gap`),
        ...(missingBaselineReference ? [`baseline:${exportEvent.baselineFingerprintId}`] : []),
      ];
      // A readable name for people: when, which window, and a short incident id.
      const packageId = incidentPackageBaseName(exportEvent);
      const exportsPath = path.join(this.root, "exports");
      stagingPath = path.join(exportsPath, `.${packageId}.partial-${randomUUID().slice(0, 8)}`);
      this.assertContained(stagingPath);
      this.updateLease(this.exportPathLeases, stagingPath, 1);
      await mkdir(path.join(stagingPath, "spectrum", "raw"), { recursive: true });
      const slice = await this.writeIncidentFrameSlice(sessions, exportEvent, stagingPath);
      if (slice.legacyFrameCount > 0) missingParts.push(`legacy-frame-provenance:${slice.legacyFrameCount}`);
      // A derived picture of the slice above. It can never make the evidence incomplete or fail the export.
      const overheadReserve = Math.min(1024 * 1024, Math.floor(this.exportPartMaxBytes * 0.35));
      const maxFigureFileBytes = Math.floor((this.exportPartMaxBytes - overheadReserve) / 4);
      const figure = await this.renderIncidentFigure(stagingPath, exportEvent, slice, baselineReference, {
        generatedAtMs: Date.now(),
        // One figure file may never crowd out the evidence in a size-bounded part.
        maxFileBytes: maxFigureFileBytes,
      });
      // The report embeds the charts so it opens on its own, but only while it stays well inside one part.
      const maxInlineBytes = Math.floor(maxFigureFileBytes / 2);
      const completeness = {
        dataDomain: this.dataDomain,
        complete: missingParts.length === 0,
        requestedSessionIds,
        availableSessionIds: sessions.map((candidate) => candidate.id),
        missingSessionIds,
        incompleteSourceSessionIds,
        missingBaselineReference,
        missingParts,
        evidenceGap: missingParts.length > 0,
      };
      void maxInlineBytes;
      const triggerSnapshot = await this.readTriggerSnapshot(exportEvent.id, requestedSessionIds);
      await Promise.all([
        writeAtomic(path.join(stagingPath, "incident.json"), JSON.stringify(sanitizeEvidence({ ...exportEvent, exportCompleteness: completeness }), null, 2)),
        this.writeIncidentFigureFiles(stagingPath, figure),
        ...(triggerSnapshot ? [writeAtomic(path.join(stagingPath, "evidence", "trigger-snapshot.json"), JSON.stringify(sanitizeEvidence(triggerSnapshot), null, 2))] : []),
        this.writeIncidentAttachments(sessions, exportEvent, stagingPath, Date.parse(slice.startedAt), Date.parse(slice.endedAt)),
        writeAtomic(path.join(stagingPath, "completeness.json"), JSON.stringify(completeness, null, 2)),
        writeAtomic(path.join(stagingPath, "slice.json"), JSON.stringify({
          schemaVersion: 2,
          dataDomain: this.dataDomain,
          scope: "incident",
          sourceSessionId: session.id,
          sourceSessionIds: requestedSessionIds,
          availableSessionIds: completeness.availableSessionIds,
          missingSessionIds,
          complete: completeness.complete,
          incidentId: eventId,
          targetId: exportEvent.targetId,
          affectedBandIds: exportEvent.affectedBandIds ?? [exportEvent.bandId],
          ...slice,
        }, null, 2)),
        ...(baselineReference
          ? [writeAtomic(path.join(stagingPath, "baseline-reference.json"), JSON.stringify(sanitizeEvidence(baselineReference), null, 2))]
          : []),
        this.writeIncidentSourceContexts(sessions, stagingPath),
        this.writeIncidentEventHistory(sessions, eventId, stagingPath),
      ]);
      // Key evidence files and their hashes, quoted in the report. The manifest
      // (written last) then covers every file, including the report itself.
      const keyFiles = (await walkFiles(stagingPath))
        .map(archivePath)
        .filter((relative) => relative === "spectrum/frames.jsonl"
          || relative.startsWith("spectrum/raw/")
          || relative === "incident.json"
          || relative === "baseline-reference.json"
          || relative === "events/history.jsonl"
          || relative === "evidence/trigger-snapshot.json")
        .sort();
      const evidenceFiles = await Promise.all(keyFiles.map(async (relative) => {
        const absolute = path.join(stagingPath!, ...relative.split("/"));
        return { path: relative, bytes: (await stat(absolute)).size, sha256: await sha256File(absolute) };
      }));
      const generatedAtMs = Date.now();
      const report = await this.buildIncidentReport(exportEvent, figure, {
        scope: "evidence-package",
        generatedAtMs,
        sessions,
        baselineReference,
        triggerSnapshot,
        completeness,
        evidenceFiles,
        report: context.report,
      });
      await Promise.all([
        writeAtomic(path.join(stagingPath, "report.json"), `${JSON.stringify(report.model)}\n`),
        writeAtomic(path.join(stagingPath, "report.html"), report.html),
        ...(report.pdf ? [writeAtomic(path.join(stagingPath, "report.pdf"), report.pdf)] : []),
        writeAtomic(path.join(stagingPath, "README-VERIFY.txt"), VERIFY_README(report.model.reference)),
        writeAtomic(path.join(stagingPath, "export-record.json"), JSON.stringify(sanitizeEvidence({
          schemaVersion: 1,
          packageType: "incident-evidence",
          reference: report.model.reference,
          incidentId: exportEvent.id,
          exportedAt: new Date(generatedAtMs).toISOString(),
          exportId: context.immutableExportId,
          requestedFrom: context.requester,
          host: os.hostname(),
          dataDomain: this.dataDomain,
          software: context.report?.runtimeIdentity,
          window: { startedAt: slice.startedAt, endedAt: slice.endedAt },
          sourceSessionIds: requestedSessionIds,
          complete: completeness.complete,
          missingParts,
          reportFiles: ["report.pdf", "report.html", "report.json"].filter((name) => name !== "report.pdf" || Boolean(report.pdf)),
        }), null, 2)),
      ]);
      const exportSuffix = context.immutableExportId ? `-${safeIdentifier(context.immutableExportId, "export id")}` : "";
      const zipPath = path.join(exportsPath, `${packageId}${exportSuffix}.zip`);
      outputPrefix = zipPath.toLowerCase().endsWith(".zip") ? zipPath.slice(0, -4) : zipPath;
      this.updateLease(this.activeExportPrefixes, outputPrefix, 1);
      return await this.writeBoundedArchives(stagingPath, packageId, zipPath, session.id, completeness, "incident-evidence");
      } finally {
        if (stagingPath) {
          this.updateLease(this.exportPathLeases, stagingPath, -1);
          await rm(stagingPath, { recursive: true, force: true });
        }
        if (outputPrefix) this.updateLease(this.activeExportPrefixes, outputPrefix, -1);
        for (const sessionId of requestedSessionIds) this.updateLease(this.exportSourceSessionLeases, sessionId, -1);
      }
    } finally {
      this.activeExportOperations = Math.max(0, this.activeExportOperations - 1);
    }
  }

  async exportSession(sessionId: string, immutableExportId?: string, minimumFreeBytes = 0): Promise<string | string[]> {
    if (this.recordingDeletionActive) throw new Error("Recording deletion is in progress; retry after it completes");
    this.updateLease(this.exportSourceSessionLeases, sessionId, 1);
    let stagingPath: string | undefined;
    let outputPrefix: string | undefined;
    try {
      const checkpoint = await this.enqueue(async () => {
        const session = await this.sessionForId(sessionId);
        await this.persistSession(session);
        this.refreshActive(session);
        const files = (await walkFiles(session.path))
          .map(archivePath)
          .filter((relativePath) => !["manifest.json", "SHA256SUMS.txt", "session.json"].includes(relativePath));
        const sizes = await Promise.all(files.map(async (relativePath) => ({
          relativePath,
          bytes: (await stat(path.join(session.path, ...relativePath.split("/")))).size,
        })));
        return { session: { ...session }, files: sizes };
      }, 64 * 1024, "high");
      await this.assertExportableSource(checkpoint.session);
      await this.ensureExportScratch(checkpoint.files.reduce((total, file) => total + file.bytes, 0), minimumFreeBytes);
      const exportSuffix = immutableExportId ? `-${safeIdentifier(immutableExportId, "export id")}` : "";
      const exportsPath = path.join(this.root, "exports");
      stagingPath = path.join(exportsPath, `.${checkpoint.session.id}${exportSuffix}.partial-${randomUUID().slice(0, 8)}`);
      this.assertContained(stagingPath);
      this.updateLease(this.exportPathLeases, stagingPath, 1);
      await mkdir(stagingPath, { recursive: true });
      for (const file of checkpoint.files) {
        const source = this.resolveWithin(checkpoint.session.path, file.relativePath);
        const destination = path.join(stagingPath, ...file.relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        if (file.bytes === 0) await writeAtomic(destination, "");
        else await pipeline(
          createReadStream(source, { start: 0, end: file.bytes - 1 }),
          createWriteStream(destination, { flags: "wx", mode: 0o640 }),
        );
      }
      const validation = await this.validateExportTree(stagingPath, checkpoint.session.id);
      await writeAtomic(path.join(stagingPath, "session.json"), JSON.stringify(sanitizeEvidence({ ...checkpoint.session, path: "." }), null, 2));
      const zipPath = path.join(exportsPath, `${checkpoint.session.id}${exportSuffix}.zip`);
      outputPrefix = zipPath.toLowerCase().endsWith(".zip") ? zipPath.slice(0, -4) : zipPath;
      this.updateLease(this.activeExportPrefixes, outputPrefix, 1);
      const completeness = this.sessionCompleteness(checkpoint.session);
      const exportCompleteness = validation.legacyFrameCount > 0
        ? {
            complete: false,
            missingParts: [...completeness.missingParts, `legacy-frame-provenance:${validation.legacyFrameCount}`],
          }
        : completeness;
      return await this.writeBoundedArchives(
        stagingPath,
        checkpoint.session.id,
        zipPath,
        checkpoint.session.id,
        exportCompleteness,
      );
    } finally {
      if (stagingPath) {
        this.updateLease(this.exportPathLeases, stagingPath, -1);
        await rm(stagingPath, { recursive: true, force: true });
      }
      if (outputPrefix) this.updateLease(this.activeExportPrefixes, outputPrefix, -1);
      this.updateLease(this.exportSourceSessionLeases, sessionId, -1);
    }
  }

  async prepareSessionExport(sessionId: string): Promise<ExportableSessionDescriptor> {
    const session = await this.sessionForId(sessionId);
    await this.assertExportableSource(session);
    const commitKey = createHash("sha256").update(JSON.stringify({
      sessionId: session.id,
      lifecycle: session.lifecycle,
      finalizedAt: session.finalizedAt ?? session.endedAt,
      byteCount: session.byteCount,
      evidenceGap: session.evidenceGap === true,
      incompleteReasons: [...(session.incompleteReasons ?? [])].sort(),
    })).digest("hex");
    return {
      sessionId: session.id,
      commitKey: `session:${session.id}:${commitKey}`,
      estimatedOutputBytes: Math.min(Number.MAX_SAFE_INTEGER, session.byteCount + 64 * 1024 * 1024),
    };
  }

  async listSessionEvents(sessionId: string): Promise<DetectionEvent[]> {
    const session = await this.sessionForId(sessionId);
    try {
      const latestById = new Map<string, DetectionEvent>();
      const eventPath = path.join(session.path, "events", "events.jsonl");
      for await (const event of boundedJsonlRecords<DetectionEvent>(eventPath, `Event index for ${sessionId}`, session.status === "recording")) {
        if (!event.id) throw new EvidenceCorruptionError(`Event index for ${sessionId} contains an event without an ID`);
        if (event.sessionId === sessionId || event.sessionIds?.includes(sessionId)) latestById.set(event.id, event);
      }
      return [...latestById.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && session.eventCount === 0) return [];
      throw error;
    }
  }

  /**
   * The newest record of an incident across every session it was written to.
   * `cache` lets one request look up several incidents with one read per session.
   */
  async findIncidentEvent(eventId: string, hintedSessionId?: string, cache?: IncidentLookupCache): Promise<DetectionEvent | undefined> {
    const safeEventId = safeIdentifier(eventId, "event id");
    const sessions = await (cache ? (cache.sessions ??= this.listSessions()) : this.listSessions());
    const ordered = hintedSessionId
      ? [...sessions.filter((session) => session.id === hintedSessionId), ...sessions.filter((session) => session.id !== hintedSessionId)]
      : sessions;
    const sessionEvents = (sessionId: string) => {
      if (!cache) return this.listSessionEvents(sessionId);
      let pending = cache.events.get(sessionId);
      if (!pending) {
        pending = this.listSessionEvents(sessionId).catch(() => []);
        cache.events.set(sessionId, pending);
      }
      return pending;
    };
    const candidates: DetectionEvent[] = [];
    for (const session of ordered) {
      const candidate = (await sessionEvents(session.id)).find((event) => event.id === safeEventId);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) return undefined;
    const score = (event: DetectionEvent) => Math.max(
      Date.parse(event.clearedAt ?? "") || 0,
      Date.parse(event.acknowledgedAt ?? "") || 0,
      Date.parse(event.lastSeenAt) || 0,
      Date.parse(event.startedAt) || 0,
    );
    const latest = [...candidates].sort((left, right) => (
      score(right) - score(left)
      || (right.sessionIds?.length ?? 1) - (left.sessionIds?.length ?? 1)
    ))[0];
    return {
      ...latest,
      sessionIds: [...new Set(candidates.flatMap((candidate) => [candidate.sessionId, ...(candidate.sessionIds ?? [])]))],
    };
  }

  async listSessions(): Promise<EvidenceSession[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      const sessions = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
        .map(async (entry) => {
          const sessionPath = this.pathForSession(entry.name);
          try {
            const session = JSON.parse(await readFile(path.join(sessionPath, "session.json"), "utf8")) as EvidenceSession;
            if (!session || typeof session !== "object" || typeof session.startedAt !== "string" || !Number.isFinite(Date.parse(session.startedAt))
              || (session.lifecycle !== undefined && !isEvidenceLifecycle(session.lifecycle))) {
              throw new EvidenceCorruptionError("Session descriptor is invalid");
            }
            return {
              ...session,
              id: entry.name,
              path: sessionPath,
              ...(session.lifecycle ? { status: legacyStatusForLifecycle(session.lifecycle) } : {}),
            };
          } catch {
            const details = await stat(sessionPath);
            return {
              id: entry.name,
              dataDomain: this.dataDomain,
              startedAt: details.mtime.toISOString(),
              path: sessionPath,
              lifecycle: "Corrupt" as const,
              status: "storage-error" as const,
              frameCount: 0,
              eventCount: 0,
              byteCount: details.size,
              evidenceGap: true,
              incompleteReasons: ["corrupt-session-descriptor"],
              finalizationError: "Session descriptor is missing or malformed",
            };
          }
        }));
      return sessions
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    } catch {
      return [];
    }
  }

  async maintain(policy: EvidenceRetentionPolicy, now = Date.now(), protectedSessionIds: ReadonlySet<string> = new Set()): Promise<StorageMaintenanceReport> {
      const sessions = await this.listSessions();
      const activeId = this.active?.id;
      const finalizingSessionIds = [
        ...(this.activeFinalizerTask ? [this.activeFinalizerTask.session.id] : []),
        ...this.finalizerTasks.map((task) => task.session.id),
      ];
      const allProtectedSessionIds = new Set([...protectedSessionIds, ...this.exportSourceSessionLeases.keys(), ...finalizingSessionIds]);
      const sessionCandidates: CleanupCandidate[] = sessions
        .filter((session) => (
          session.id !== activeId
          && session.lifecycle !== "Finalizing"
          && session.lifecycle !== "Corrupt"
          && !allProtectedSessionIds.has(session.id)
        ))
        .map((session) => ({
          type: "session",
          id: session.id,
          absolutePath: this.pathForSession(session.id),
          bytes: session.byteCount,
          timestamp: Date.parse(session.endedAt ?? session.startedAt),
        }));
      const exportCandidates = await this.exportCandidates();
      const allCandidates = [...exportCandidates, ...sessionCandidates];
      let storageBytes = sessions.reduce((total, session) => total + session.byteCount, 0)
        + exportCandidates.reduce((total, item) => total + item.bytes, 0);
      let availableBytes = await this.availableBytes();
      const deletedSessionIds: string[] = [];
      const deletedExportFiles: string[] = [];
      let reclaimedBytes = 0;

      const removeCandidate = async (candidate: CleanupCandidate) => {
        await this.removeContained(candidate.absolutePath);
        storageBytes = Math.max(0, storageBytes - candidate.bytes);
        availableBytes += candidate.bytes;
        reclaimedBytes += candidate.bytes;
        if (candidate.type === "session") deletedSessionIds.push(candidate.id);
        else deletedExportFiles.push(candidate.id);
      };

      const retentionCutoff = now - policy.retentionMs;
      for (const candidate of allCandidates.filter((item) => !item.protected && item.timestamp < retentionCutoff)) {
        await removeCandidate(candidate);
      }

      const deleted = new Set([...deletedSessionIds, ...deletedExportFiles]);
      const pressureCandidates = allCandidates
        .filter((candidate) => !candidate.protected && !deleted.has(candidate.id))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "export" ? -1 : 1;
          return a.timestamp - b.timestamp;
        });
      for (const candidate of pressureCandidates) {
        if (storageBytes <= policy.storageMaxBytes && availableBytes >= policy.minimumFreeBytes) break;
        await removeCandidate(candidate);
      }

      availableBytes = await this.availableBytes();

      const report: StorageMaintenanceReport = {
        ...policy,
        lastRunAt: new Date(now).toISOString(),
        storageBytes,
        availableBytes,
        deletedSessions: deletedSessionIds.length,
        deletedExports: deletedExportFiles.length,
        reclaimedBytes,
        pressure: storageBytes > policy.storageMaxBytes || availableBytes < policy.minimumFreeBytes,
        deletedSessionIds,
        deletedExportFiles,
      };
      await this.appendMaintenanceLog(report);
      return report;
  }

  /**
   * Delete only finalized recordings in this store's explicit trust domain.
   * The live session, finalizers, and export-leased sessions are retained.
   * Renames create a recoverable commit boundary before physical cleanup.
   */
  async deleteRecordings(actor: string): Promise<RecordingDeletionResult> {
    const operationId = randomUUID();
    const empty = (state: RecordingDeletionResult["state"], recoveryReason?: string): RecordingDeletionResult => ({
      state,
      dataDomain: this.dataDomain,
      deletedSessions: 0,
      deletedBytes: 0,
      retainedActiveSessions: this.active ? 1 : 0,
      retainedFinalizingSessions: 0,
      retainedLeasedSessions: this.exportSourceSessionLeases.size,
      operationId,
      auditDurable: false,
      ...(recoveryReason ? { recoveryReason } : {}),
    });
    if (this.recordingDeletionActive) return empty("refused", "recording-deletion-already-active");
    this.recordingDeletionActive = true;
    let journal: RecordingDeletionJournal | undefined;
    try {
      await this.flush();
      if (this.activeExportOperations > 0) {
        const result = empty("refused", "export-in-progress");
        result.auditDurable = await this.appendRecordingDeletionAudit({ ...result, actor });
        return result;
      }
      const sessions = await this.listSessions();
      const activeId = this.active?.id;
      const finalizingIds = new Set([
        ...(this.activeFinalizerTask ? [this.activeFinalizerTask.session.id] : []),
        ...this.finalizerTasks.map((task) => task.session.id),
        ...sessions.filter((session) => session.lifecycle === "Finalizing").map((session) => session.id),
      ]);
      const leasedIds = new Set(this.exportSourceSessionLeases.keys());
      const candidates = sessions.filter((session) => (
        session.id !== activeId && !finalizingIds.has(session.id) && !leasedIds.has(session.id)
      ));
      const retained = {
        retainedActiveSessions: activeId ? 1 : 0,
        retainedFinalizingSessions: finalizingIds.size,
        retainedLeasedSessions: leasedIds.size,
      };
      const sizes = await Promise.all(candidates.map(async (session) => ({
        id: session.id,
        bytes: await this.directoryBytes(session.path),
      })));
      const deletedBytes = sizes.reduce((total, candidate) => total + candidate.bytes, 0);
      journal = {
        schemaVersion: 1,
        operationId,
        dataDomain: this.dataDomain,
        actor: actor.slice(0, 128),
        requestedAt: new Date().toISOString(),
        phase: "prepared",
        sessionIds: sizes.map((candidate) => candidate.id),
        renamedSessionIds: [],
        deletedBytes,
        ...retained,
      };
      if (!sizes.length) {
        const result: RecordingDeletionResult = {
          state: "complete",
          dataDomain: this.dataDomain,
          deletedSessions: 0,
          deletedBytes: 0,
          ...retained,
          operationId,
          auditDurable: false,
        };
        result.auditDurable = await this.appendRecordingDeletionAudit({ ...result, actor });
        return result;
      }

      const quarantine = this.recordingDeletionQuarantine(operationId);
      await writeAtomic(this.recordingDeletionJournalPath(), JSON.stringify(journal, null, 2));
      await mkdir(quarantine, { recursive: false, mode: 0o750 });
      await syncDirectory(this.root);
      for (const candidate of sizes) {
        await rename(this.pathForSession(candidate.id), path.join(quarantine, candidate.id));
        journal.renamedSessionIds.push(candidate.id);
        await writeAtomic(this.recordingDeletionJournalPath(), JSON.stringify(journal, null, 2));
        if (journal.renamedSessionIds.length === 1) await this.injectRecordingDeletionFault("after-first-rename", operationId);
      }
      await syncDirectory(quarantine);
      await syncDirectory(this.root);
      journal.phase = "committed";
      await writeAtomic(this.recordingDeletionJournalPath(), JSON.stringify(journal, null, 2));
      await this.injectRecordingDeletionFault("after-commit", operationId);
      await this.injectRecordingDeletionFault("before-audit", operationId);
      const result: RecordingDeletionResult = {
        state: "complete",
        dataDomain: this.dataDomain,
        deletedSessions: sizes.length,
        deletedBytes,
        ...retained,
        operationId,
        auditDurable: false,
      };
      result.auditDurable = await this.appendRecordingDeletionAudit({ ...result, actor });
      journal.phase = "audited";
      await writeAtomic(this.recordingDeletionJournalPath(), JSON.stringify(journal, null, 2));
      await this.injectRecordingDeletionFault("before-cleanup", operationId);
      await this.removeContained(quarantine);
      await unlink(this.recordingDeletionJournalPath());
      await syncDirectory(this.root);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (journal?.phase === "prepared") {
        try {
          await this.rollbackPreparedRecordingDeletion(journal);
          const result: RecordingDeletionResult = {
            state: "refused",
            dataDomain: this.dataDomain,
            deletedSessions: 0,
            deletedBytes: 0,
            retainedActiveSessions: journal.retainedActiveSessions,
            retainedFinalizingSessions: journal.retainedFinalizingSessions,
            retainedLeasedSessions: journal.retainedLeasedSessions,
            operationId,
            auditDurable: false,
            recoveryReason: reason.slice(0, 1_024),
          };
          result.auditDurable = await this.appendRecordingDeletionAudit({ ...result, actor });
          return result;
        } catch (rollbackError) {
          return {
            state: "recovery-required",
            dataDomain: this.dataDomain,
            deletedSessions: 0,
            deletedBytes: 0,
            retainedActiveSessions: journal.retainedActiveSessions,
            retainedFinalizingSessions: journal.retainedFinalizingSessions,
            retainedLeasedSessions: journal.retainedLeasedSessions,
            operationId,
            auditDurable: false,
            recoveryReason: `rollback-failed:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`.slice(0, 1_024),
          };
        }
      }
      if (journal?.phase === "committed" || journal?.phase === "audited") {
        return {
          state: "recovery-required",
          dataDomain: this.dataDomain,
          deletedSessions: journal.sessionIds.length,
          deletedBytes: journal.deletedBytes,
          retainedActiveSessions: journal.retainedActiveSessions,
          retainedFinalizingSessions: journal.retainedFinalizingSessions,
          retainedLeasedSessions: journal.retainedLeasedSessions,
          operationId,
          auditDurable: journal.phase === "audited",
          recoveryReason: reason.slice(0, 1_024),
        };
      }
      const result = empty("refused", reason.slice(0, 1_024));
      result.auditDurable = await this.appendRecordingDeletionAudit({ ...result, actor }).catch(() => false);
      return result;
    } finally {
      this.recordingDeletionActive = false;
    }
  }

  private async prepareFinalizing(session: EvidenceSession): Promise<void> {
    if (session.lifecycle && session.lifecycle !== "Active") throw new Error(`Evidence session ${session.id} is not active`);
    await Promise.all([
      unlink(path.join(session.path, "manifest.json")).catch(() => undefined),
      unlink(path.join(session.path, "SHA256SUMS.txt")).catch(() => undefined),
      unlink(path.join(session.path, "session-final.json")).catch(() => undefined),
      unlink(path.join(session.path, "finalization.json")).catch(() => undefined),
    ]);
    await this.syncSessionEvidence(session);
    const checkpointAt = new Date().toISOString();
    session.endedAt = checkpointAt;
    session.durabilityCheckpointAt = checkpointAt;
    session.finalizationStartedAt = checkpointAt;
    session.lifecycle = "Finalizing";
    session.status = legacyStatusForLifecycle(session.lifecycle);
    session.verification = { outcome: "not-run" };
    delete session.finalizedAt;
    delete session.finalizationError;
    await this.checkpointSession(session, true);
  }

  private async syncSessionEvidence(session: EvidenceSession): Promise<void> {
    this.assertContained(session.path);
    const excluded = new Set(["session.json", "manifest.json", "SHA256SUMS.txt", "session-final.json", "finalization.json"]);
    const files = (await walkFiles(session.path))
      .map(archivePath)
      .filter((relativePath) => !excluded.has(relativePath) && !relativePath.includes(".partial-"));
    for (const relativePath of files) {
      const handle = await open(path.join(session.path, ...relativePath.split("/")), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const directories = new Set<string>([session.path]);
    for (const relativePath of files) {
      let directory = path.dirname(path.join(session.path, ...relativePath.split("/")));
      while (directory.startsWith(session.path)) {
        directories.add(directory);
        if (directory === session.path) break;
        directory = path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await syncDirectory(directory);
    }
  }

  private scheduleFinalization(session: EvidenceSession): Promise<EvidenceSession> | undefined {
    const queueItems = this.finalizerTasks.length + (this.activeFinalizerTask ? 1 : 0);
    if (queueItems >= this.finalizerMaxItems) {
      this.finalizerRejectedTotal += 1;
      return undefined;
    }
    return new Promise<EvidenceSession>((resolve) => {
      this.finalizerTasks.push({ session: { ...session }, enqueuedAt: Date.now(), resolve });
      void this.drainFinalizers();
    });
  }

  private async drainFinalizers(): Promise<void> {
    if (this.finalizerDraining) return;
    this.finalizerDraining = true;
    try {
      while (this.finalizerTasks.length) {
        const task = this.finalizerTasks.shift()!;
        this.activeFinalizerTask = task;
        let finalized: EvidenceSession;
        try {
          finalized = await this.finalizeSession(task.session);
        } catch (error) {
          // A second storage failure can prevent even the explicit failure
          // descriptor from being refreshed. Keep the on-disk Finalizing state
          // fail-closed and surface the error in bounded health.
          const reason = this.finalizationErrorMessage(error);
          task.session.lifecycle = "Finalizing";
          task.session.status = legacyStatusForLifecycle(task.session.lifecycle);
          task.session.finalizationError = reason;
          this.finalizerLastFailure = {
            sessionId: task.session.id,
            at: new Date().toISOString(),
            lifecycle: "Finalizing",
            reason,
          };
          finalized = { ...task.session };
        } finally {
          this.activeFinalizerTask = undefined;
        }
        task.resolve(finalized);
      }
    } finally {
      this.finalizerDraining = false;
      if (this.finalizerTasks.length) {
        void this.drainFinalizers();
      } else if (!this.activeFinalizerTask) {
        for (const resolve of this.finalizerIdleWaiters.splice(0)) resolve();
      }
    }
  }

  private async finalizeSession(session: EvidenceSession): Promise<EvidenceSession> {
    try {
      if (session.lifecycle !== "Finalizing") throw new Error(`Session ${session.id} is not ready to finalize`);
      if (!session.durabilityCheckpointAt) {
        session.evidenceGap = true;
        session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "missing-durability-checkpoint"])];
      }
      await this.validateExportTree(session.path, session.id);
      const lifecycle: "Complete" | "Incomplete" = session.evidenceGap ? "Incomplete" : "Complete";
      const finalizedAt = new Date().toISOString();
      const finalDescriptor: EvidenceSession = {
        ...session,
        path: ".",
        lifecycle,
        status: legacyStatusForLifecycle(lifecycle),
        finalizedAt,
      };
      delete finalDescriptor.finalizationError;
      await this.injectFinalizationFault("write", session.id);
      await writeAtomic(path.join(session.path, "session-final.json"), JSON.stringify(sanitizeEvidence(finalDescriptor), null, 2));
      await this.injectFinalizationFault("hash", session.id);
      const manifest = await this.createManifestForSession(session, lifecycle);
      const manifestPath = path.join(session.path, "manifest.json");
      const sumsPath = path.join(session.path, "SHA256SUMS.txt");
      const [manifestSha256, sha256SumsSha256] = await Promise.all([
        sha256File(manifestPath),
        sha256File(sumsPath),
      ]);
      const commit = createEvidenceFinalizationRecord({
        sessionId: session.id,
        dataDomain: this.dataDomain,
        lifecycle,
        committedAt: finalizedAt,
        manifestSha256,
        sha256SumsSha256,
      });
      await this.writeFinalizationCommit(session, commit);
      const verification = await verifyEvidenceDirectory(session.path, { expectedDataDomain: this.dataDomain });
      const expectedOutcome = lifecycle === "Complete" ? "PASS" : "INCOMPLETE";
      if (verification.outcome !== expectedOutcome) {
        throw new EvidenceCorruptionError(`Finalized evidence verification returned ${verification.outcome}: ${verification.reasons.join(",")}`);
      }
      session.lifecycle = lifecycle;
      session.status = legacyStatusForLifecycle(lifecycle);
      session.finalizedAt = finalizedAt;
      session.verification = {
        outcome: verification.outcome === "PASS" ? "pass" : "incomplete",
        verifiedAt: new Date().toISOString(),
        ...(verification.reasons.length ? { reasons: verification.reasons.slice(0, 16) } : {}),
      };
      delete session.finalizationError;
      try {
        await this.persistSession(session);
      } catch (error) {
        // finalization.json is the atomic authoritative descriptor commit. A
        // legacy descriptor refresh can be recovered deterministically later.
        this.finalizerLastFailure = {
          sessionId: session.id,
          at: new Date().toISOString(),
          lifecycle: "Finalizing",
          reason: `descriptor-refresh:${this.finalizationErrorMessage(error)}`,
        };
      }
      if (manifest.complete) this.finalizerCompletedTotal += 1;
      else this.finalizerIncompleteTotal += 1;
      return { ...session };
    } catch (error) {
      return this.markFinalizationFailure(session, error);
    }
  }

  private async createManifestForSession(
    session: EvidenceSession,
    committedLifecycle?: "Complete" | "Incomplete",
  ): Promise<EvidenceManifest> {
    this.assertContained(session.path);
    return this.createManifestForRoot(
      session.path,
      session.id,
      this.sessionCompleteness(committedLifecycle ? { ...session, lifecycle: committedLifecycle } : session),
      committedLifecycle ? new Set(["session.json", "finalization.json"]) : undefined,
    );
  }

  private async writeFinalizationCommit(session: EvidenceSession, commit: object): Promise<void> {
    const finalPath = path.join(session.path, "finalization.json");
    const temporary = `${finalPath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
    let renamed = false;
    const handle = await open(temporary, "wx", 0o640);
    try {
      await handle.writeFile(JSON.stringify(commit, null, 2));
      await handle.sync();
      await handle.close();
      await this.injectFinalizationFault("rename", session.id);
      await rename(temporary, finalPath);
      renamed = true;
      await this.injectFinalizationFault("fsync", session.id);
      await syncDirectory(session.path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (renamed) {
        await unlink(finalPath).catch(() => undefined);
        await syncDirectory(session.path).catch(() => undefined);
      }
      throw error;
    }
  }

  private async markFinalizationRejected(session: EvidenceSession): Promise<void> {
    session.lifecycle = "Incomplete";
    session.status = legacyStatusForLifecycle(session.lifecycle);
    session.evidenceGap = true;
    session.finalizationError = "finalizer-queue-full";
    session.verification = { outcome: "not-run" };
    session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "finalizer-queue-full"])];
    this.finalizerIncompleteTotal += 1;
    this.finalizerLastFailure = {
      sessionId: session.id,
      at: new Date().toISOString(),
      lifecycle: "Incomplete",
      reason: "finalizer-queue-full",
    };
    await this.persistSession(session);
  }

  private async markFinalizationFailure(session: EvidenceSession, error: unknown): Promise<EvidenceSession> {
    await unlink(path.join(session.path, "finalization.json")).catch(() => undefined);
    const corrupt = error instanceof EvidenceCorruptionError;
    const lifecycle: "Incomplete" | "Corrupt" = corrupt ? "Corrupt" : "Incomplete";
    const reason = this.finalizationErrorMessage(error);
    session.lifecycle = lifecycle;
    session.status = legacyStatusForLifecycle(lifecycle);
    session.finalizedAt = new Date().toISOString();
    session.finalizationError = reason;
    session.verification = corrupt
      ? { outcome: "fail", verifiedAt: new Date().toISOString(), reasons: [reason.slice(0, 256)] }
      : { outcome: "not-run" };
    session.evidenceGap = true;
    session.incompleteReasons = [...new Set([
      ...(session.incompleteReasons ?? []),
      corrupt ? "corrupt-evidence" : "finalization-failed",
    ])];
    if (corrupt) this.finalizerCorruptTotal += 1;
    else this.finalizerIncompleteTotal += 1;
    this.finalizerLastFailure = {
      sessionId: session.id,
      at: session.finalizedAt,
      lifecycle,
      reason,
    };
    await this.persistSession(session);
    return { ...session };
  }

  private finalizationErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return (message || "Evidence finalization failed").replace(/[\r\n]+/g, " ").slice(0, 1_024);
  }

  private async injectFinalizationFault(point: EvidenceFinalizationFaultPoint, sessionId: string): Promise<void> {
    this.injectProcessKillFault(`finalization-${point}`, sessionId);
    await this.finalizationFaultInjector?.(point, sessionId);
  }

  private injectProcessKillFault(point: EvidenceProcessKillFaultPoint, sessionId: string): void {
    const fault = this.processKillFault;
    if (!fault || fault.triggered || fault.point !== point || !existsSync(fault.armFile)) return;
    fault.triggered = true;
    let marker: number | undefined;
    try {
      marker = openSync(fault.markerFile, "wx", 0o600);
      writeSync(marker, `${JSON.stringify({
        schemaVersion: 1,
        point,
        sessionId,
        pid: process.pid,
      })}\n`);
      fsyncSync(marker);
    } finally {
      if (marker !== undefined) closeSync(marker);
    }
    process.kill(process.pid, "SIGKILL");
  }

  private sessionCompleteness(session: EvidenceSession): { complete: boolean; missingParts: readonly string[] } {
    const lifecycleGap = session.lifecycle === "Active"
      ? "session-active"
      : session.lifecycle === "Finalizing"
        ? "finalization-not-committed"
        : session.lifecycle === "Incomplete"
          ? "session-incomplete"
          : session.lifecycle === "Corrupt" ? "session-corrupt" : undefined;
    const reasons = [...new Set([
      ...(session.incompleteReasons ?? []),
      ...(lifecycleGap ? [lifecycleGap] : []),
    ])];
    const complete = session.lifecycle === "Complete"
      || (session.lifecycle === undefined && session.status === "closed" && session.evidenceGap !== true);
    return {
      complete,
      missingParts: complete
        ? []
        : (reasons.length ? reasons : ["unknown-evidence-gap"]).map((reason) => `${session.id}:${reason}`),
    };
  }

  private async createManifestForRoot(
    root: string,
    sessionId: string,
    completeness: { complete: boolean; missingSessionIds?: readonly string[]; missingParts?: readonly string[] } = { complete: true },
    additionallyExcluded: ReadonlySet<string> = new Set(),
    packageType?: EvidenceManifest["packageType"],
  ): Promise<EvidenceManifest> {
    this.assertContained(root);
    const excluded = new Set(["manifest.json", "SHA256SUMS.txt", ...additionallyExcluded]);
    const files = (await walkFiles(root))
      .map(archivePath)
      .filter((file) => !excluded.has(file));
    const entries: EvidenceManifestEntry[] = [];
    for (const relativePath of [...files].sort()) {
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const fileStat = await stat(absolutePath);
      entries.push({
        path: relativePath,
        bytes: fileStat.size,
        sha256: await sha256File(absolutePath),
      });
    }
    const runtimeIdentity = await runtimeIdentityFromEvidenceRoot(root);
    const manifest: EvidenceManifest = {
      schemaVersion: 2,
      dataDomain: this.dataDomain,
      sessionId,
      generatedAt: new Date().toISOString(),
      hashAlgorithm: "SHA-256",
      files: entries,
      complete: completeness.complete,
      missingParts: [...(completeness.missingParts ?? completeness.missingSessionIds ?? [])],
      evidenceGap: !completeness.complete,
      ...(runtimeIdentity ? { runtimeIdentity } : {}),
      ...(packageType ? { packageType } : {}),
      disclaimer: "Tamper-evident engineering archive; not a certified legal chain of custody.",
    };
    const manifestPath = path.join(root, "manifest.json");
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    const manifestHash = await sha256File(manifestPath);
    const sums = [
      ...entries.map((entry) => `${entry.sha256}  ${entry.path}`),
      `${manifestHash}  manifest.json`,
    ].join("\n");
    await writeAtomic(path.join(root, "SHA256SUMS.txt"), `${sums}\n`);
    return manifest;
  }

  private async writeArchive(sourcePath: string, archiveRoot: string, zipPath: string): Promise<void> {
    this.assertContained(sourcePath);
    this.assertContained(zipPath);
    await mkdir(path.dirname(zipPath), { recursive: true });
    const partialPath = `${zipPath}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(partialPath, { flags: "wx", mode: 0o640 });
        const archive = new ZipArchive({ store: true });
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        output.on("close", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        output.on("error", fail);
        archive.on("error", fail);
        archive.pipe(output);
        archive.directory(sourcePath, archiveRoot);
        void archive.finalize().catch(fail);
      });
      const archiveHandle = await open(partialPath, "r");
      try {
        await archiveHandle.sync();
      } finally {
        await archiveHandle.close();
      }
      // Hard-link publication is atomic and fails with EEXIST, so an immutable
      // export ID can never overwrite an earlier artifact.
      await link(partialPath, zipPath);
      await unlink(partialPath).catch(() => undefined);
      await syncDirectory(path.dirname(zipPath));
    } catch (error) {
      await unlink(partialPath).catch(() => undefined);
      throw error;
    }
  }

  private async writeBoundedArchives(
    sourcePath: string,
    archiveRoot: string,
    zipPath: string,
    sessionId: string,
    completeness: { complete: boolean; missingSessionIds?: readonly string[]; missingParts?: readonly string[] } = { complete: true },
    packageType?: EvidenceManifest["packageType"],
  ): Promise<string | string[]> {
    const overheadReserve = Math.min(1024 * 1024, Math.floor(this.exportPartMaxBytes * 0.35));
    const contentBudget = this.exportPartMaxBytes - overheadReserve;
    await this.splitOversizedJsonlFiles(sourcePath, contentBudget);
    const excluded = new Set(["manifest.json", "SHA256SUMS.txt"]);
    const files = (await walkFiles(sourcePath))
      .map(archivePath)
      .filter((relativePath) => !excluded.has(relativePath));
    const sized = await Promise.all(files.map(async (relativePath) => ({
      relativePath,
      bytes: (await stat(path.join(sourcePath, ...relativePath.split("/")))).size,
    })));
    const oversized = sized.find((file) => file.bytes > contentBudget);
    if (oversized) throw new Error(`Export file ${oversized.relativePath} exceeds the multipart content bound`);
    const ordered = sized.sort((left, right) => {
      const leftRaw = left.relativePath.includes("/raw/") ? 1 : 0;
      const rightRaw = right.relativePath.includes("/raw/") ? 1 : 0;
      return leftRaw - rightRaw || left.relativePath.localeCompare(right.relativePath);
    });
    const groups: typeof ordered[] = [];
    let current: typeof ordered = [];
    let currentBytes = 0;
    for (const file of ordered) {
      if (current.length && currentBytes + file.bytes > contentBudget) {
        groups.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.bytes;
    }
    if (current.length || !groups.length) groups.push(current);
    if (groups.length === 1) {
      await this.createManifestForRoot(sourcePath, sessionId, completeness, new Set(), packageType);
      await this.writeArchive(sourcePath, archiveRoot, zipPath);
      if ((await stat(zipPath)).size > this.exportPartMaxBytes) throw new Error("Export ZIP exceeded the 256 MiB part bound");
      return zipPath;
    }

    const digestedGroups = await Promise.all(groups.map((group) => Promise.all(group.map(async (file) => ({
      ...file,
      sha256: await sha256File(path.join(sourcePath, ...file.relativePath.split("/"))),
    })))));
    const reconstructionSha256 = createHash("sha256").update(
      digestedGroups.flat()
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((file) => `${file.sha256} ${file.bytes} ${file.relativePath}\n`)
        .join(""),
    ).digest("hex");

    const basePath = zipPath.toLowerCase().endsWith(".zip") ? zipPath.slice(0, -4) : zipPath;
    const outputPaths: string[] = [];
    const partRoots: string[] = [];
    try {
      for (let index = 0; index < digestedGroups.length; index += 1) {
        const partNumber = index + 1;
        const partRoot = path.join(path.dirname(zipPath), `.${path.basename(basePath)}-part-${String(partNumber).padStart(3, "0")}.partial-${randomUUID().slice(0, 8)}`);
        partRoots.push(partRoot);
        await mkdir(partRoot, { recursive: true });
        for (const file of digestedGroups[index]) {
          const destination = path.join(partRoot, ...file.relativePath.split("/"));
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(path.join(sourcePath, ...file.relativePath.split("/")), destination);
        }
        await writeAtomic(path.join(partRoot, "multipart.json"), JSON.stringify({
          schemaVersion: 2,
          archiveRoot,
          partNumber,
          totalParts: digestedGroups.length,
          reconstructionSha256,
          includedFiles: digestedGroups[index].map((file) => file.relativePath),
          files: digestedGroups[index].map((file) => ({ path: file.relativePath, bytes: file.bytes, sha256: file.sha256 })),
          noTruncation: true,
        }, null, 2));
        await this.createManifestForRoot(partRoot, sessionId, completeness, new Set(), packageType);
        const partPath = `${basePath}-part-${String(partNumber).padStart(3, "0")}.zip`;
        await this.writeArchive(partRoot, archiveRoot, partPath);
        if ((await stat(partPath)).size > this.exportPartMaxBytes) throw new Error(`Export part ${partNumber} exceeded its resource bound`);
        outputPaths.push(partPath);
      }
      return outputPaths;
    } catch (error) {
      await Promise.all(outputPaths.map((outputPath) => unlink(outputPath).catch(() => undefined)));
      throw error;
    } finally {
      await Promise.all(partRoots.map((partRoot) => rm(partRoot, { recursive: true, force: true })));
    }
  }

  private async splitOversizedJsonlFiles(root: string, contentBudget: number): Promise<void> {
    const files = (await walkFiles(root)).map(archivePath);
    for (const relativePath of files) {
      const source = path.join(root, ...relativePath.split("/"));
      if ((await stat(source)).size <= contentBudget) continue;
      if (!relativePath.endsWith(".jsonl")) continue;
      const extension = ".jsonl";
      const base = relativePath.slice(0, -extension.length);
      let part = 0;
      let partBytes = 0;
      let destination = "";
      const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
      for await (const line of lines) {
        const record = `${line}\n`;
        const recordBytes = Buffer.byteLength(record);
        if (recordBytes > contentBudget) throw new Error(`JSONL record in ${relativePath} exceeds the multipart bound`);
        if (!destination || partBytes + recordBytes > contentBudget) {
          part += 1;
          partBytes = 0;
          destination = path.join(root, ...`${base}-part-${String(part).padStart(3, "0")}${extension}`.split("/"));
          await mkdir(path.dirname(destination), { recursive: true });
        }
        await appendFile(destination, record);
        partBytes += recordBytes;
      }
      await unlink(source);
    }
  }

  private async appendFrame(frame: PersistedSpectrumFrame, summary: object): Promise<void> {
    const session = this.requireActive();
    this.validatePersistedFrame(frame);
    await this.ensureFrameIndexClean(session);
    const raw = Buffer.from(frame.bins.buffer, frame.bins.byteOffset, frame.bins.byteLength);
    if (raw.byteLength > this.rawChunkMaxBytes) throw new Error(`Evidence frame exceeds the ${this.rawChunkMaxBytes}-byte raw chunk bound`);
    const chunk = this.rawChunkForFrame(session, frame.timestamp, raw.byteLength);
    const rawOffset = chunk.bytes;
    const jsonLine = `${JSON.stringify({
      ...(sanitizeEvidence(summary) as Record<string, unknown>),
      schemaVersion: 2,
      frame: sanitizeEvidence({ ...frame, bins: undefined }),
      rawFile: chunk.relativePath,
      rawOffset,
      rawLength: raw.byteLength,
      rawEncoding: "uint8",
    })}\n`;
    try {
      await appendFile(chunk.absolutePath, raw);
    } catch (error) {
      // A short write (ENOSPC) leaves the file longer than chunk.bytes; the next frame's offset would
      // then point into the middle of this one.
      await this.rollbackRawAppends([{ chunk, bytes: rawOffset }]);
      throw error;
    }
    chunk.bytes += raw.byteLength;
    this.injectProcessKillFault("frame-after-raw-append", session.id);
    try {
      await appendFile(path.join(session.path, "spectrum", "frames.jsonl"), jsonLine);
    } catch (error) {
      await this.repairFrameIndexTail(session);
      throw error;
    }
    this.injectProcessKillFault("frame-after-index-append", session.id);
    session.frameCount += 1;
    session.byteCount += raw.byteLength + Buffer.byteLength(jsonLine);
    await this.checkpointSession(session);
  }

  /**
   * Append one bounded pre-history chunk with one raw append per destination
   * chunk and one index append. The former per-frame open/append/close loop
   * could keep the priority writer older than the two-second critical limit
   * while a 60-second ring was being frozen. Thirty-two frames keep both the
   * transient buffers and the crash-recovery boundary small.
   */
  private async appendPrehistoryChunk(items: readonly PrehistoryEvidenceFrame[]): Promise<void> {
    if (!items.length || items.length > PREHISTORY_CHUNK_FRAMES) {
      throw new Error(`Prehistory writer chunk must contain 1-${PREHISTORY_CHUNK_FRAMES} frames`);
    }
    const session = this.requireActive();
    await this.ensureFrameIndexClean(session);
    const rawWrites = new Map<string, { absolutePath: string; buffers: Buffer[] }>();
    // Length of every touched chunk before this batch, so a failed write can be undone exactly.
    const priorBytes = new Map<RawChunkState, number>();
    const indexLines: string[] = [];
    let addedBytes = 0;

    for (const { frame, summary } of items) {
      this.validatePersistedFrame(frame);
      const raw = Buffer.from(frame.bins.buffer, frame.bins.byteOffset, frame.bins.byteLength);
      if (raw.byteLength > this.rawChunkMaxBytes) {
        throw new Error(`Evidence frame exceeds the ${this.rawChunkMaxBytes}-byte raw chunk bound`);
      }
      const chunk = this.rawChunkForFrame(session, frame.timestamp, raw.byteLength);
      const rawOffset = chunk.bytes;
      if (!priorBytes.has(chunk)) priorBytes.set(chunk, chunk.bytes);
      chunk.bytes += raw.byteLength;
      const write = rawWrites.get(chunk.relativePath) ?? { absolutePath: chunk.absolutePath, buffers: [] };
      write.buffers.push(raw);
      rawWrites.set(chunk.relativePath, write);
      const jsonLine = `${JSON.stringify({
        ...(sanitizeEvidence(summary) as Record<string, unknown>),
        schemaVersion: 2,
        frame: sanitizeEvidence({ ...frame, bins: undefined }),
        rawFile: chunk.relativePath,
        rawOffset,
        rawLength: raw.byteLength,
        rawEncoding: "uint8",
      })}\n`;
      indexLines.push(jsonLine);
      addedBytes += raw.byteLength + Buffer.byteLength(jsonLine);
    }

    try {
      for (const write of rawWrites.values()) {
        await appendFile(write.absolutePath, Buffer.concat(write.buffers));
      }
    } catch (error) {
      // chunk.bytes was advanced before the write; without this the recorded offsets of every later
      // frame would run ahead of the real file.
      await this.rollbackRawAppends([...priorBytes].map(([chunk, bytes]) => ({ chunk, bytes })));
      throw error;
    }
    this.injectProcessKillFault("frame-after-raw-append", session.id);
    try {
      await appendFile(path.join(session.path, "spectrum", "frames.jsonl"), indexLines.join(""));
    } catch (error) {
      await this.repairFrameIndexTail(session);
      throw error;
    }
    this.injectProcessKillFault("frame-after-index-append", session.id);
    session.frameCount += items.length;
    session.byteCount += addedBytes;
    await this.checkpointSession(session);
  }

  /**
   * Undo raw appends whose index lines were never written: restore each chunk's logical length and
   * cut the file back to it. If the file cannot be cut, retire the chunk so no offset is ever
   * computed from a length that disagrees with the file.
   */
  private async rollbackRawAppends(items: ReadonlyArray<{ chunk: RawChunkState; bytes: number }>): Promise<void> {
    for (const { chunk, bytes } of items) {
      chunk.bytes = bytes;
      try {
        await truncate(chunk.absolutePath, bytes);
      } catch (error) {
        // A chunk that was never created has nothing to cut.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") chunk.poisoned = true;
      }
    }
  }

  private frameIndexNeedsRepair = false;

  /**
   * A failed index append can leave a torn line; the next append would join onto it. Preserve and cut
   * the torn bytes now, using the same reconciliation as crash recovery. If that fails too, refuse
   * further frames until a later repair succeeds.
   */
  private async repairFrameIndexTail(session: EvidenceSession): Promise<void> {
    try {
      await this.reconcileInterruptedJsonlTail(session, "spectrum/frames.jsonl", new Date().toISOString());
      this.frameIndexNeedsRepair = false;
    } catch {
      this.frameIndexNeedsRepair = true;
    }
  }

  private async ensureFrameIndexClean(session: EvidenceSession): Promise<void> {
    if (!this.frameIndexNeedsRepair) return;
    await this.repairFrameIndexTail(session);
    if (this.frameIndexNeedsRepair) throw new Error("Evidence frame index has an unrepaired torn tail; frames are refused until it is repaired");
  }

  private validatePersistedFrame(frame: SpectrumFrame): asserts frame is PersistedSpectrumFrame {
    this.validateSyntheticEvidenceBoundary(frame.syntheticExercise, frame.dataDomain, frame.source);
    if (frame.dataDomain !== this.dataDomain) {
      throw new Error(`Evidence frame belongs to ${frame.dataDomain ?? "unscoped"} data, not ${this.dataDomain}`);
    }
    if (this.dataDomain === "field" && frame.source === "simulation") {
      throw new Error("Simulation frames cannot enter field evidence");
    }
    if (!(frame.bins instanceof Uint8Array)) throw new Error("Evidence frames require Uint8Array bins");
    if (frame.bins.byteLength === 0 || frame.bins.byteLength > MAX_STORED_FRAME_BINS) {
      throw new Error(`Evidence frames require 1-${MAX_STORED_FRAME_BINS} already-reduced uint8 bins`);
    }
    if (!frame.targetId || !frame.scanWindowId || !frame.visitId) throw new Error("Evidence frames require target, window, and visit provenance");
    if (!Number.isSafeInteger(frame.configurationEpoch) || (frame.configurationEpoch ?? 0) <= 0) throw new Error("Evidence frame configuration epoch is invalid");
    if (!Number.isSafeInteger(frame.tuneEpoch) || (frame.tuneEpoch ?? 0) <= 0) throw new Error("Evidence frame tune epoch is invalid");
    if (!Number.isSafeInteger(frame.visitEpoch) || (frame.visitEpoch ?? 0) <= 0) throw new Error("Evidence frame visit epoch is invalid");
    if (!Number.isFinite(frame.receivedMonotonicMs) || (frame.receivedMonotonicMs ?? -1) < 0) throw new Error("Evidence frame monotonic receipt time is invalid");
    if (!Number.isFinite(frame.requestedCenterHz) || (frame.requestedCenterHz ?? 0) <= 0) throw new Error("Evidence frame requested center is invalid");
    if (!Number.isFinite(frame.confirmedCenterHz) || (frame.confirmedCenterHz ?? 0) <= 0) throw new Error("Evidence frame confirmed center is invalid");
    if (!Number.isFinite(frame.confirmedSampleRateHz) || (frame.confirmedSampleRateHz ?? 0) <= 0) throw new Error("Evidence frame confirmed sample rate is invalid");
    if (!Number.isSafeInteger(frame.inputBinCount) || (frame.inputBinCount ?? 0) < frame.bins.length) throw new Error("Evidence frame input bin count is invalid");
    if (frame.binning !== "native" && frame.binning !== "peak-preserving") throw new Error("Evidence frame binning is invalid");
    if (
      !Number.isSafeInteger(frame.analysisStartBin)
      || !Number.isSafeInteger(frame.analysisEndBin)
      || (frame.analysisStartBin ?? -1) < 0
      || (frame.analysisEndBin ?? 0) <= (frame.analysisStartBin ?? 0)
      || (frame.analysisEndBin ?? 0) > frame.bins.length
    ) throw new Error("Evidence frame analysis mask is invalid");
    const detectorError = detectorAnalysisError(frame as unknown as Record<string, unknown>, frame.bins.length);
    if (detectorError) throw new Error(`Evidence frame ${detectorError}`);
    if (!Number.isFinite(frame.analysisSpanHz) || (frame.analysisSpanHz ?? 0) <= 0 || (frame.analysisSpanHz ?? Infinity) > 8_000_000) {
      throw new Error("Evidence frame analysis span is invalid");
    }
    if (!Number.isFinite(frame.captureSpanHz) || (frame.captureSpanHz ?? 0) < (frame.analysisSpanHz ?? Infinity)) throw new Error("Evidence frame capture span is invalid");
    if (!Number.isFinite(Date.parse(frame.timestamp)) || !Number.isFinite(Date.parse(frame.tuneConfirmedAt ?? ""))) {
      throw new Error("Evidence frame UTC timestamps are invalid");
    }
  }

  private validateSyntheticEvidenceBoundary(
    marker: unknown,
    payloadDomain: unknown,
    source?: unknown,
  ): void {
    if (marker === undefined) return;
    const markerError = syntheticExerciseMarkerError(marker);
    if (markerError) throw new Error(`Synthetic exercise evidence rejected: ${markerError}`);
    if (this.dataDomain !== "test" || payloadDomain !== "test") {
      throw new Error("Synthetic exercise evidence requires an isolated test-domain store and test-domain payload");
    }
    if (source !== undefined && source !== "simulation") {
      throw new Error("Synthetic exercise frames require the simulation source");
    }
  }

  private rawChunkForFrame(session: EvidenceSession, timestamp: string, rawLength: number): RawChunkState {
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) throw new Error("Evidence frame timestamp is invalid");
    const hour = new Date(at).toISOString().slice(0, 13);
    let chunk = this.rawChunksByHour.get(hour);
    if (!chunk || chunk.poisoned || chunk.bytes + rawLength > this.rawChunkMaxBytes) {
      const part = (chunk?.part ?? 0) + 1;
      const rawName = `frames-${safeTimestamp(hour)}-part-${String(part).padStart(3, "0")}.bin`;
      const relativePath = path.posix.join("spectrum", "raw", rawName);
      chunk = {
        part,
        relativePath,
        absolutePath: path.join(session.path, ...relativePath.split("/")),
        bytes: 0,
      };
      this.rawChunksByHour.set(hour, chunk);
    }
    return chunk;
  }

  private async readBoundedJsonObject(filePath: string, label: string, maximumBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
    const details = await stat(filePath);
    if (details.size <= 0 || details.size > maximumBytes) throw new EvidenceCorruptionError(`${label} is empty or exceeds its resource bound`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      throw new EvidenceCorruptionError(`${label} contains malformed JSON`);
    }
    if (!isRecord(parsed)) throw new EvidenceCorruptionError(`${label} must contain a JSON object`);
    return parsed;
  }

  private expectedBaselineGeneration(event: DetectionEvent): number | undefined {
    const explicit = Number(event.baselineGenerationId);
    if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
    const protectedGeneration = event.baselineId?.match(/:([1-9][0-9]*)$/)?.[1];
    return protectedGeneration ? Number(protectedGeneration) : undefined;
  }

  private validateBaselineReference(reference: object, event: DetectionEvent): object {
    const record = reference as Record<string, unknown>;
    const descriptor = record.descriptor;
    if (!isRecord(descriptor) || descriptor.fingerprintId !== event.baselineFingerprintId) {
      throw new EvidenceCorruptionError(`Baseline reference for ${event.id} does not match its fingerprint`);
    }
    const expectedGeneration = this.expectedBaselineGeneration(event);
    if (expectedGeneration !== undefined && descriptor.generation !== expectedGeneration) {
      throw new EvidenceCorruptionError(`Baseline reference for ${event.id} does not match generation ${expectedGeneration}`);
    }
    return reference;
  }

  private async resolveIncidentBaselineReference(
    sessions: readonly EvidenceSession[],
    event: DetectionEvent,
    supplied?: object,
  ): Promise<object | undefined> {
    if (supplied) return this.validateBaselineReference(supplied, event);
    for (const session of sessions) {
      const baselinePath = path.join(session.path, "events", "baselines", `${safeIdentifier(event.id, "event id")}.json`);
      try {
        return this.validateBaselineReference(
          await this.readBoundedJsonObject(baselinePath, `Baseline reference for ${event.id}`),
          event,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return undefined;
  }

  private async writeIncidentSourceContexts(sessions: readonly EvidenceSession[], destination: string): Promise<void> {
    const contextRoot = path.join(destination, "source-context");
    const index: Array<{ sessionId: string; config: string; sdrconnect: string; evidenceGap: boolean; incompleteReasons: string[] }> = [];
    for (const session of sessions) {
      const safeSessionId = safeIdentifier(session.id, "session id");
      const sourceConfig = await this.readBoundedJsonObject(path.join(session.path, "config.json"), `Configuration context for ${safeSessionId}`);
      const sourceSdrconnect = await this.readBoundedJsonObject(path.join(session.path, "sdrconnect.json"), `SDRconnect context for ${safeSessionId}`);
      const relativeRoot = path.posix.join("source-context", safeSessionId);
      await Promise.all([
        writeAtomic(path.join(contextRoot, safeSessionId, "config.json"), JSON.stringify(sanitizeEvidence(sourceConfig), null, 2)),
        writeAtomic(path.join(contextRoot, safeSessionId, "sdrconnect.json"), JSON.stringify(sanitizeEvidence(sourceSdrconnect), null, 2)),
      ]);
      index.push({
        sessionId: safeSessionId,
        config: path.posix.join(relativeRoot, "config.json"),
        sdrconnect: path.posix.join(relativeRoot, "sdrconnect.json"),
        evidenceGap: session.evidenceGap === true,
        incompleteReasons: [...(session.incompleteReasons ?? [])],
      });
    }
    await writeAtomic(path.join(contextRoot, "index.json"), JSON.stringify({ schemaVersion: 1, sessions: index }, null, 2));
  }

  private decodeIndexedFrameRecord(indexed: Record<string, unknown>, label: string): {
    frame: Record<string, unknown>;
    rawFile: string;
    rawOffset: number;
    rawLength: number;
    legacy: boolean;
  } {
    if (!isRecord(indexed.frame)) throw new EvidenceCorruptionError(`${label} is missing frame metadata`);
    const frame = indexed.frame;
    if (typeof indexed.rawFile !== "string" || indexed.rawEncoding !== "uint8") {
      throw new EvidenceCorruptionError(`${label} is missing its uint8 raw source`);
    }
    if (!indexed.rawFile.startsWith("spectrum/raw/") || !indexed.rawFile.endsWith(".bin")) {
      throw new EvidenceCorruptionError(`${label} has an invalid raw evidence path`);
    }
    const rawOffset = indexed.rawOffset;
    const rawLength = indexed.rawLength;
    if (
      !Number.isSafeInteger(rawOffset)
      || (rawOffset as number) < 0
      || !Number.isSafeInteger(rawLength)
      || (rawLength as number) <= 0
      || (rawLength as number) > MAX_STORED_FRAME_BINS
      || !Number.isSafeInteger((rawOffset as number) + (rawLength as number))
    ) throw new EvidenceCorruptionError(`${label} has an invalid raw range`);
    if (
      typeof frame.id !== "string"
      || typeof frame.timestamp !== "string"
      || !Number.isFinite(Date.parse(frame.timestamp))
      || !Number.isSafeInteger(frame.receiver)
      || (frame.receiver as number) < 0
      || typeof frame.bandId !== "string"
      || !Number.isFinite(frame.startHz)
      || !Number.isFinite(frame.endHz)
      || (frame.endHz as number) <= (frame.startHz as number)
      || !["sdrconnect", "simulation"].includes(String(frame.source))
      || typeof frame.calibrated !== "boolean"
    ) throw new EvidenceCorruptionError(`${label} has invalid basic frame metadata`);

    const legacy = indexed.schemaVersion !== 2;
    if (indexed.schemaVersion !== undefined && indexed.schemaVersion !== 1 && indexed.schemaVersion !== 2) {
      throw new EvidenceCorruptionError(`${label} has an unsupported schema version`);
    }
    if (!legacy) {
      if (frame.dataDomain !== this.dataDomain) {
        throw new EvidenceCorruptionError(`${label} crosses the ${this.dataDomain} data-domain boundary`);
      }
      const stringFields = ["targetId", "scanWindowId", "visitId", "binning", "tuneConfirmedAt"] as const;
      if (stringFields.some((field) => typeof frame[field] !== "string" || !(frame[field] as string).trim())) {
        throw new EvidenceCorruptionError(`${label} is missing persisted-frame provenance`);
      }
      const positiveIntegerFields = ["inputBinCount", "configurationEpoch", "tuneEpoch", "analysisEndBin"] as const;
      if (positiveIntegerFields.some((field) => !Number.isSafeInteger(frame[field]) || (frame[field] as number) <= 0)) {
        throw new EvidenceCorruptionError(`${label} has invalid persisted-frame counters`);
      }
      // visitEpoch was added to v2 writers after the initial v2 rollout. Keep
      // old evidence readable, but reject a malformed value whenever present.
      if (frame.visitEpoch !== undefined && (!Number.isSafeInteger(frame.visitEpoch) || (frame.visitEpoch as number) <= 0)) {
        throw new EvidenceCorruptionError(`${label} has an invalid visit epoch`);
      }
      const positiveNumberFields = [
        "requestedCenterHz",
        "confirmedCenterHz",
        "confirmedSampleRateHz",
        "analysisSpanHz",
        "captureSpanHz",
      ] as const;
      if (positiveNumberFields.some((field) => !Number.isFinite(frame[field]) || (frame[field] as number) <= 0)) {
        throw new EvidenceCorruptionError(`${label} has invalid confirmed RF state`);
      }
      if (!Number.isFinite(frame.receivedMonotonicMs) || (frame.receivedMonotonicMs as number) < 0) {
        throw new EvidenceCorruptionError(`${label} has invalid monotonic receipt time`);
      }
      if (
        !Number.isSafeInteger(frame.analysisStartBin)
        || (frame.analysisStartBin as number) < 0
        || (frame.analysisEndBin as number) <= (frame.analysisStartBin as number)
        || (frame.analysisEndBin as number) > (rawLength as number)
        || (frame.analysisSpanHz as number) > 8_000_000
        || (frame.captureSpanHz as number) < (frame.analysisSpanHz as number)
        || frame.requestedCenterHz !== frame.confirmedCenterHz
      ) throw new EvidenceCorruptionError(`${label} has an invalid analysis mask or RF confirmation`);
      const detectorError = detectorAnalysisError(frame, rawLength as number);
      if (detectorError) throw new EvidenceCorruptionError(`${label} ${detectorError}`);
      const inputBinCount = frame.inputBinCount as number;
      if (
        (frame.binning === "native" && inputBinCount !== rawLength)
        || (frame.binning === "peak-preserving" && inputBinCount <= (rawLength as number))
        || !["native", "peak-preserving"].includes(String(frame.binning))
      ) throw new EvidenceCorruptionError(`${label} has inconsistent native/stored bin counts`);
      const tuneConfirmedAt = Date.parse(frame.tuneConfirmedAt as string);
      if (!Number.isFinite(tuneConfirmedAt) || tuneConfirmedAt > Date.parse(frame.timestamp as string)) {
        throw new EvidenceCorruptionError(`${label} has an invalid tune confirmation timestamp`);
      }
    }
    return {
      frame,
      rawFile: indexed.rawFile,
      rawOffset: rawOffset as number,
      rawLength: rawLength as number,
      legacy,
    };
  }

  private async writeIncidentFrameSlice(sessions: readonly EvidenceSession[], event: DetectionEvent, destination: string): Promise<IncidentSliceSummary> {
    const eventStart = Date.parse(event.startedAt);
    const eventEnd = Date.parse(event.clearedAt ?? event.endedAt ?? event.lastSeenAt);
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd < eventStart) throw new Error("Incident timestamps are invalid");
    const startedAtMs = eventStart - this.incidentPrehistoryMs;
    const endedAtMs = eventEnd + (event.clearedAt ? this.incidentPostClearMs : 0);
    const outputIndex = path.join(destination, "spectrum", "frames.jsonl");
    await writeAtomic(outputIndex, "");
    const incidentBands = new Set(event.affectedBandIds ?? [event.bandId]);
    const rawDestinations = new Map<string, { relativePath: string; absolutePath: string; bytes: number }>();
    let frameCount = 0;
    let legacyFrameCount = 0;
    let rawBytes = 0;

    for (const session of sessions) {
      const sourceIndex = path.join(session.path, "spectrum", "frames.jsonl");
      try {
        for await (const indexed of boundedJsonlRecords<Record<string, unknown>>(
          sourceIndex,
          `Spectrum index for ${session.id}`,
          session.status === "recording",
        )) {
        const decoded = this.decodeIndexedFrameRecord(indexed, `Spectrum index for ${session.id}`);
        const frameRecord = decoded.frame;
        const frameAt = typeof frameRecord.timestamp === "string" ? Date.parse(frameRecord.timestamp) : Number.NaN;
        if (!Number.isFinite(frameAt) || frameAt < startedAtMs || frameAt > endedAtMs) continue;
        const sameBand = typeof frameRecord.bandId === "string" && incidentBands.has(frameRecord.bandId);
        const sameTarget = event.targetId
          ? frameRecord.targetId === event.targetId || (frameRecord.targetId === undefined && sameBand)
          : sameBand;
        if (!sameTarget) continue;
        const rawOffset = decoded.rawOffset;
        const rawLength = decoded.rawLength;
        const sourceRaw = this.resolveWithin(session.path, decoded.rawFile);
        const sourceSize = (await stat(sourceRaw)).size;
        if (rawOffset + rawLength > sourceSize) throw new Error("Incident frame raw range exceeds its source chunk");
        const rawDestinationKey = `${session.id}:${decoded.rawFile}`;
        let rawDestination = rawDestinations.get(rawDestinationKey);
        if (!rawDestination) {
          const sourceName = path.basename(decoded.rawFile);
          const relativePath = sessions.length === 1
            ? path.posix.join("spectrum", "raw", sourceName)
            : path.posix.join("spectrum", "raw", session.id, sourceName);
          rawDestination = {
            relativePath,
            absolutePath: path.join(destination, ...relativePath.split("/")),
            bytes: 0,
          };
          await mkdir(path.dirname(rawDestination.absolutePath), { recursive: true });
          rawDestinations.set(rawDestinationKey, rawDestination);
        }
        const destinationOffset = rawDestination.bytes;
        await pipeline(
          createReadStream(sourceRaw, { start: rawOffset, end: rawOffset + rawLength - 1 }),
          createWriteStream(rawDestination.absolutePath, { flags: "a", mode: 0o640 }),
        );
        rawDestination.bytes += rawLength;
        rawBytes += rawLength;
        frameCount += 1;
        if (decoded.legacy) legacyFrameCount += 1;
        const safeIndex = sanitizeEvidence({
          ...indexed,
          rawFile: rawDestination.relativePath,
          rawOffset: destinationOffset,
          rawLength,
          rawEncoding: "uint8",
          sourceSessionId: session.id,
        });
        await appendFile(outputIndex, `${JSON.stringify(safeIndex)}\n`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && session.frameCount === 0) continue;
        throw error;
      }
    }

    return {
      frameCount,
      legacyFrameCount,
      rawBytes,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
    };
  }

  /**
   * Saves a time-stamped picture of one incident under `incident-figures/<incident>/`. It reads only
   * the recorded frames (staged first, exactly like an export) and never changes evidence. Returns
   * undefined when there is nothing to draw from.
   */
  async saveIncidentFigureSnapshot(
    event: DetectionEvent,
    options: { reason: IncidentFigureReason; baselineReference?: object; now?: number; report?: IncidentReportContext },
  ): Promise<{ stamp: string; svgPath: string; pngPath: string; analysisPath: string; reportPath: string } | undefined> {
    if (event.syntheticExercise) return undefined;
    if (this.recordingDeletionActive) return undefined;
    const incidentId = safeIdentifier(event.id, "event id");
    const now = options.now ?? Date.now();
    const sessions: EvidenceSession[] = [];
    for (const sessionId of new Set([event.sessionId, ...(event.sessionIds ?? [])])) {
      try {
        const candidate = await this.sessionForId(sessionId);
        if (candidate.lifecycle !== "Corrupt" && candidate.status !== "storage-error") sessions.push(candidate);
      } catch {
        // A session that was removed or cannot be read simply contributes no frames.
      }
    }
    if (!sessions.length) return undefined;
    const exportsPath = path.join(this.root, "exports");
    const stagingPath = path.join(exportsPath, `.figure-${incidentId}.partial-${randomUUID().slice(0, 8)}`);
    this.assertContained(stagingPath);
    this.updateLease(this.exportPathLeases, stagingPath, 1);
    try {
      await mkdir(path.join(stagingPath, "spectrum", "raw"), { recursive: true });
      const slice = await this.writeIncidentFrameSlice(sessions, event, stagingPath);
      if (slice.frameCount === 0) return undefined;
      const figure = await this.renderIncidentFigure(stagingPath, event, slice, options.baselineReference, {
        generatedAtMs: now,
        maxFileBytes: INCIDENT_FIGURE_MAX_FILE_BYTES,
      });
      if (!figure.svg || !figure.png || !figure.analysis) return undefined;
      const directory = path.join(this.root, INCIDENT_FIGURE_DIRECTORY, incidentId);
      this.assertContained(directory);
      const stamp = figureStamp(now);
      const svgPath = path.join(directory, `${stamp}-${options.reason}.svg`);
      const pngPath = path.join(directory, `${stamp}-${options.reason}.png`);
      const analysisPath = path.join(directory, `${stamp}-${options.reason}-analysis.svg`);
      const reportPath = path.join(directory, `${stamp}-${options.reason}-report.html`);
      const reportJsonPath = path.join(directory, `${stamp}-${options.reason}-report.json`);
      const triggerSnapshot = await this.readTriggerSnapshot(event.id, sessions.map((candidate) => candidate.id));
      const report = await this.buildIncidentReport(event, figure, {
        scope: "live-snapshot",
        generatedAtMs: now,
        sessions,
        baselineReference: options.baselineReference,
        triggerSnapshot,
        report: options.report,
        withPdf: false,
      });
      const reportJson = `${JSON.stringify(report.model)}\n`;
      await writeAtomic(pngPath, figure.png);
      await writeAtomic(analysisPath, figure.analysis.sheetSvg);
      if (Buffer.byteLength(reportJson) <= INCIDENT_FIGURE_MAX_FILE_BYTES) await writeAtomic(reportJsonPath, reportJson);
      if (Buffer.byteLength(report.html) <= INCIDENT_FIGURE_MAX_FILE_BYTES) await writeAtomic(reportPath, report.html);
      // The overview goes last, so a reader that finds it can rely on its companions being there.
      await writeAtomic(svgPath, figure.svg);
      await this.copyToShare(incidentId, stamp, options.reason, figure, report.html);
      return { stamp, svgPath, pngPath, analysisPath, reportPath };
    } finally {
      this.updateLease(this.exportPathLeases, stagingPath, -1);
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  /**
   * Best effort copy for people who open files from a folder instead of the dashboard. A share that is
   * missing or not writable never affects the picture saved in the evidence store.
   */
  private async copyToShare(incidentId: string, stamp: string, reason: IncidentFigureReason, figure: IncidentFigureFiles, report: string): Promise<void> {
    if (!this.shareDirectory || !figure.svg || !figure.png || !figure.analysis) return;
    try {
      const details = await lstat(this.shareDirectory);
      if (!details.isDirectory() || details.isSymbolicLink()) return;
      const directory = path.join(this.shareDirectory, incidentId);
      await mkdir(directory, { recursive: true, mode: 0o750 });
      const base = path.join(directory, `${stamp}-${reason}`);
      await writeAtomicUnflushed(`${base}.png`, figure.png);
      await writeAtomicUnflushed(`${base}-analysis.svg`, figure.analysis.sheetSvg);
      await writeAtomicUnflushed(`${base}.svg`, figure.svg);
      await writeAtomicUnflushed(`${base}-report.html`, report);
    } catch (error) {
      const now = Date.now();
      if (now - this.shareFailureLoggedAt > 10 * 60_000) {
        this.shareFailureLoggedAt = now;
        console.warn(`Incident images could not be copied to the share folder: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Newest saved picture for an incident, or undefined. Only names this store wrote are served. */
  async readIncidentFigure(incidentId: string, kind: "svg" | "png" | "analysis" | "report-html" | "report-json"): Promise<{ bytes: Buffer; stamp: string; reason: IncidentFigureReason } | undefined> {
    const directory = path.join(this.root, INCIDENT_FIGURE_DIRECTORY, safeIdentifier(incidentId, "event id"));
    this.assertContained(directory);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return undefined;
    }
    const candidates = names
      .map((name) => ({ name, match: INCIDENT_FIGURE_NAME.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null && (kind === "analysis"
        ? entry.match[3] === "-analysis" && entry.match[4] === "svg"
        : kind === "report-html"
          ? entry.match[3] === "-report" && entry.match[4] === "html"
          : kind === "report-json"
            ? entry.match[3] === "-report" && entry.match[4] === "json"
            : entry.match[3] === undefined && entry.match[4] === kind))
      .sort((left, right) => right.name.localeCompare(left.name));
    const newest = candidates[0];
    if (!newest) return undefined;
    const file = path.join(directory, newest.name);
    const details = await lstat(file);
    if (!details.isFile() || details.size > INCIDENT_FIGURE_MAX_FILE_BYTES) return undefined;
    return { bytes: await readFile(file), stamp: newest.match[1], reason: newest.match[2] as IncidentFigureReason };
  }

  /** Incident ids that currently have a saved picture, for the history list. */
  async listIncidentFigureIds(): Promise<Set<string>> {
    try {
      const entries = await readdir(path.join(this.root, INCIDENT_FIGURE_DIRECTORY), { withFileTypes: true });
      return new Set(entries.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name)).map((entry) => entry.name));
    } catch {
      return new Set();
    }
  }

  /**
   * Deletes saved pictures older than the retention period, then the oldest ones beyond the hard file
   * cap. Only files this store names are touched, and symbolic links are never followed.
   */
  async pruneIncidentFigures(retentionMs: number, now = Date.now(), maxFiles = INCIDENT_FIGURE_MAX_FILES): Promise<{ removedFiles: number; keptFiles: number }> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) return { removedFiles: 0, keptFiles: 0 };
    const roots = [path.join(this.root, INCIDENT_FIGURE_DIRECTORY), ...(this.shareDirectory ? [this.shareDirectory] : [])];
    let removedFiles = 0;
    let keptFiles = 0;
    for (const base of roots) {
      const result = await this.pruneFigureRoot(base, retentionMs, now, maxFiles);
      removedFiles += result.removedFiles;
      keptFiles += result.keptFiles;
    }
    return { removedFiles, keptFiles };
  }

  private async pruneFigureRoot(base: string, retentionMs: number, now: number, maxFiles: number): Promise<{ removedFiles: number; keptFiles: number }> {
    let incidents;
    try {
      incidents = await readdir(base, { withFileTypes: true });
    } catch {
      return { removedFiles: 0, keptFiles: 0 };
    }
    const files: Array<{ file: string; at: number; directory: string }> = [];
    for (const incident of incidents) {
      if (!incident.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(incident.name)) continue;
      const directory = path.join(base, incident.name);
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const match = entry.isFile() ? INCIDENT_FIGURE_NAME.exec(entry.name) : null;
        if (!match) continue;
        const at = figureStampMs(match[1]);
        files.push({ file: path.join(directory, entry.name), at: Number.isFinite(at) ? at : 0, directory });
      }
    }
    files.sort((left, right) => left.at - right.at);
    const expired = new Set(files.filter((entry) => now - entry.at > retentionMs).map((entry) => entry.file));
    const remaining = files.filter((entry) => !expired.has(entry.file));
    for (const entry of remaining.slice(0, Math.max(0, remaining.length - maxFiles))) expired.add(entry.file);
    let removed = 0;
    for (const entry of files) {
      if (!expired.has(entry.file)) continue;
      await unlink(entry.file).then(() => { removed += 1; }, () => undefined);
    }
    for (const incident of incidents) {
      // rmdir only removes an empty directory, so an incident that still has pictures is untouched.
      if (incident.isDirectory() && /^[A-Za-z0-9._-]+$/.test(incident.name)) await rmdir(path.join(base, incident.name)).catch(() => undefined);
    }
    return { removedFiles: removed, keptFiles: files.length - removed };
  }

  private async writeIncidentFigureFiles(destination: string, figure: IncidentFigureFiles): Promise<void> {
    const directory = path.join(destination, "figures");
    await mkdir(directory, { recursive: true });
    const writes = [writeAtomic(path.join(directory, "figure.json"), `${JSON.stringify(figure.summary, null, 2)}\n`)];
    if (figure.svg && figure.png) {
      writes.push(writeAtomic(path.join(directory, "incident-overview.svg"), figure.svg));
      writes.push(writeAtomic(path.join(directory, "waterfall.png"), figure.png));
    }
    if (figure.analysis) {
      writes.push(writeAtomic(path.join(directory, "incident-analysis.svg"), figure.analysis.sheetSvg));
      for (const chart of figure.analysis.charts) writes.push(writeAtomic(path.join(destination, ...chart.file.split("/")), chart.svg));
    }
    await Promise.all(writes);
  }

  /**
   * Draws the incident overview from the already-staged frame slice (never from live sources), so the
   * picture is reproducible from exactly the bytes that are hashed into the package.
   */
  private async renderIncidentFigure(
    stagingPath: string,
    event: DetectionEvent,
    slice: IncidentSliceSummary,
    baselineReference: object | undefined,
    options: { generatedAtMs: number; maxFileBytes: number },
  ): Promise<IncidentFigureFiles> {
    const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
    try {
      const indexPath = path.join(stagingPath, "spectrum", "frames.jsonl");
      const timestamps: number[] = [];
      for await (const indexed of boundedJsonlRecords<Record<string, unknown>>(indexPath, "Incident figure index", false)) {
        const frame = isRecord(indexed.frame) ? indexed.frame : undefined;
        const at = typeof frame?.timestamp === "string" ? Date.parse(frame.timestamp) : Number.NaN;
        if (Number.isFinite(at)) timestamps.push(at);
      }
      timestamps.sort((left, right) => left - right);
      const incidentStartMs = Date.parse(event.startedAt);
      const incidentEndMs = Date.parse(event.clearedAt ?? event.endedAt ?? event.lastSeenAt);
      let baseline: { median: Uint8Array; mad: Uint8Array } | undefined;
      const arrays = isRecord(baselineReference) && isRecord((baselineReference as Record<string, unknown>).arrays)
        ? (baselineReference as { arrays: Record<string, unknown> }).arrays
        : undefined;
      if (arrays && typeof arrays.medianBase64 === "string" && typeof arrays.madBase64 === "string") {
        const median = Uint8Array.from(Buffer.from(arrays.medianBase64, "base64"));
        const mad = Uint8Array.from(Buffer.from(arrays.madBase64, "base64"));
        if (median.length > 0 && median.length === mad.length) baseline = { median, mad };
      }
      const builder = new IncidentFigureBuilder({
        incidentId: event.id,
        label: event.affectedLabel ?? event.bandLabel,
        rangeHz: event.affectedRangeHz,
        evidenceStrength: event.evidenceStrength === "Medium" ? "Medium" : "Low",
        lifecycle: event.lifecycle ?? "active",
        observed: event.observed,
        windowStartMs: Date.parse(slice.startedAt),
        windowEndMs: Date.parse(slice.endedAt),
        incidentStartMs,
        incidentEndMs,
        baseline,
        sourceFramesSha256: await sha256File(indexPath),
        frameTimestampsMs: timestamps,
        generatedAtMs: options.generatedAtMs,
        verdict: rfVerdictFor(event),
        alertSigma: event.trigger?.policy.values.segmentSigma ?? 6,
      });
      for await (const indexed of boundedJsonlRecords<Record<string, unknown>>(indexPath, "Incident figure frames", false)) {
        const decoded = this.decodeIndexedFrameRecord(indexed, "Incident figure frames");
        const frame = decoded.frame;
        let handle = handles.get(decoded.rawFile);
        if (!handle) {
          handle = await open(this.resolveWithin(stagingPath, decoded.rawFile), "r");
          handles.set(decoded.rawFile, handle);
        }
        const bins = Buffer.alloc(decoded.rawLength);
        const { bytesRead } = await handle.read(bins, 0, decoded.rawLength, decoded.rawOffset);
        if (bytesRead !== decoded.rawLength) throw new Error("Incident figure frame is shorter than its index");
        const analysisStartBin = Number.isSafeInteger(frame.analysisStartBin) ? (frame.analysisStartBin as number) : 0;
        const analysisEndBin = Number.isSafeInteger(frame.analysisEndBin) ? (frame.analysisEndBin as number) : decoded.rawLength;
        const detector = isRecord(frame.detectorAnalysis) ? frame.detectorAnalysis : undefined;
        const anomalyBinRanges = Array.isArray(detector?.anomalyBinRanges)
          ? (detector!.anomalyBinRanges as unknown[]).filter((range): range is { startBin: number; endBin: number } => isRecord(range)
            && Number.isSafeInteger(range.startBin) && Number.isSafeInteger(range.endBin) && (range.endBin as number) > (range.startBin as number)).slice(0, 64)
          : undefined;
        builder.add({
          timestampMs: Date.parse(frame.timestamp as string),
          bins: new Uint8Array(bins.buffer, bins.byteOffset, bins.byteLength),
          startHz: frame.startHz as number,
          endHz: frame.endHz as number,
          analysisStartBin,
          analysisEndBin,
          ...(anomalyBinRanges?.length ? { anomalyBinRanges } : {}),
        });
      }
      const result = builder.finish();
      const largest = Math.max(
        Buffer.byteLength(result.svg),
        result.waterfallPng.byteLength,
        Buffer.byteLength(result.analysis.sheetSvg),
        ...result.analysis.charts.map((chart) => Buffer.byteLength(chart.svg)),
      );
      if (largest > options.maxFileBytes) {
        return { summary: { state: "unavailable", reason: "figure is larger than this archive part size allows" } };
      }
      return { svg: result.svg, png: result.waterfallPng, analysis: result.analysis, data: result.data, summary: result.summary };
    } catch (error) {
      return { summary: { state: "unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : "figure could not be drawn" } };
    } finally {
      await Promise.all([...handles.values()].map((handle) => handle.close().catch(() => undefined)));
    }
  }

  /**
   * Builds the client report from evidence already staged for this incident.
   * The PDF is optional so a failure there never blocks the evidence.
   */
  private async buildIncidentReport(
    event: DetectionEvent,
    figure: IncidentFigureFiles,
    options: {
      scope: IncidentReportModel["scope"];
      generatedAtMs: number;
      sessions: readonly EvidenceSession[];
      baselineReference?: object;
      triggerSnapshot?: AlertTriggerSnapshot;
      completeness?: { complete: boolean; missingParts: string[] };
      evidenceFiles?: Array<{ path: string; bytes: number; sha256: string }>;
      report?: IncidentReportContext;
      withPdf?: boolean;
    },
  ): Promise<{ model: IncidentReportModel; html: string; pdf?: Uint8Array }> {
    const firstSession = options.sessions[0];
    const readJson = async (name: string) => {
      if (!firstSession) return undefined;
      try {
        return await this.readBoundedJsonObject(path.join(firstSession.path, name), `${name} for the report`);
      } catch {
        return undefined;
      }
    };
    const [sessionConfig, sdrconnect] = await Promise.all([readJson("config.json"), readJson("sdrconnect.json")]);
    const context = options.report;
    const logoDataUri = context?.logo ? `data:${context.logo.mediaType};base64,${Buffer.from(context.logo.bytes).toString("base64")}` : undefined;
    // The same wording rules as every other evidence file apply to the report.
    const reportEvent = sanitizeEvidence(structuredClone(event)) as DetectionEvent;
    const model = buildIncidentReportModel({
      event: reportEvent,
      generatedAtMs: options.generatedAtMs,
      scope: options.scope,
      dataDomain: this.dataDomain,
      siteName: context?.siteName ?? (typeof sessionConfig?.siteName === "string" ? sessionConfig.siteName : "RF Monitor site"),
      deploymentId: context?.deploymentId ?? (typeof sessionConfig?.deploymentId === "string" ? sessionConfig.deploymentId : undefined),
      displayTimeZone: context?.displayTimeZone ?? "UTC",
      reportIdentity: context?.reportIdentity,
      logoDataUri,
      serviceLabel: context?.serviceLabel,
      runtimeIdentity: context?.runtimeIdentity ?? sessionConfig?.runtimeIdentity,
      figure: figureForReport(figure),
      triggerSnapshot: options.triggerSnapshot,
      baselineReference: options.baselineReference,
      sessionConfig,
      sdrconnect,
      completeness: options.completeness,
      evidenceFiles: options.evidenceFiles,
    });
    const html = renderIncidentReportHtml(model);
    let pdf: Uint8Array | undefined;
    if (options.withPdf !== false) {
      try {
        pdf = await renderIncidentReportPdf(model);
      } catch (error) {
        console.warn(`Incident report PDF could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { model, html, pdf };
  }

  /** Render the PDF for a saved report model (used for the in-app report). */
  async renderReportPdf(model: IncidentReportModel): Promise<Uint8Array> {
    return renderIncidentReportPdf(model);
  }

  /**
   * Everything an operator added or the system logged about this incident:
   * screenshots, note files, and the operations, configuration-audit and
   * receiver logs that fall inside the incident window (plus a margin).
   */
  private async writeIncidentAttachments(
    sessions: readonly EvidenceSession[],
    event: DetectionEvent,
    destination: string,
    windowStartMs: number,
    windowEndMs: number,
  ): Promise<void> {
    const safeEventId = safeIdentifier(event.id, "event id");
    const from = (Number.isFinite(windowStartMs) ? windowStartMs : Date.parse(event.startedAt)) - INCIDENT_LOG_MARGIN_MS;
    const to = (Number.isFinite(windowEndMs) ? windowEndMs : Date.now()) + INCIDENT_LOG_MARGIN_MS;
    let screenshots = 0;
    const logLines: Record<"operations" | "configuration-audit" | "sdrconnect-events", string[]> = { operations: [], "configuration-audit": [], "sdrconnect-events": [] };
    for (const session of sessions) {
      const safeSessionId = safeIdentifier(session.id, "session id");
      try {
        for (const name of (await readdir(path.join(session.path, "screenshots", safeEventId))).sort()) {
          if (!/^[A-Za-z0-9._-]+\.png$/.test(name) || screenshots >= MAX_EXPORT_SCREENSHOTS) continue;
          const source = path.join(session.path, "screenshots", safeEventId, name);
          const details = await lstat(source);
          if (!details.isFile() || details.size > 8 * 1024 * 1024) continue;
          await mkdir(path.join(destination, "evidence", "screenshots", safeSessionId), { recursive: true });
          await copyFile(source, path.join(destination, "evidence", "screenshots", safeSessionId, name));
          screenshots += 1;
        }
      } catch {
        // No screenshots for this incident in this session.
      }
      try {
        for (const name of (await readdir(path.join(session.path, "notes"))).sort()) {
          if (!name.endsWith(`-${safeEventId}.json`)) continue;
          const source = path.join(session.path, "notes", name);
          const details = await lstat(source);
          if (!details.isFile() || details.size > 64 * 1024) continue;
          await mkdir(path.join(destination, "evidence", "notes"), { recursive: true });
          await copyFile(source, path.join(destination, "evidence", "notes", name));
        }
      } catch {
        // No notes directory.
      }
      for (const log of Object.keys(logLines) as Array<keyof typeof logLines>) {
        const source = path.join(session.path, `${log}.jsonl`);
        let anchor: string | undefined;
        try {
          for await (const entry of boundedJsonlRecords<Record<string, unknown>>(source, `${log} for ${safeSessionId}`, session.status === "recording")) {
            const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
            const line = JSON.stringify(sanitizeEvidence({ ...entry, sourceSessionId: safeSessionId }));
            if (Number.isFinite(at) && at >= from && at <= to) {
              // The configuration audit is hash-chained: keep the entry before
              // the window so the first in-window entry can be checked.
              if (log === "configuration-audit" && anchor && !logLines[log].length) logLines[log].push(anchor);
              logLines[log].push(line);
            } else if (Number.isFinite(at) && at < from) anchor = line;
            if (logLines[log].length >= 2_000) break;
          }
        } catch {
          // A session without this log contributes nothing.
        }
      }
    }
    // Added after the source sessions were finalized: kept in the review log, not in a session.
    for (const entry of await this.reviews.entriesFor(event.id)) {
      if (entry.type !== "note") continue;
      await writeAtomic(
        path.join(destination, "evidence", "notes", `${safeTimestamp(entry.at)}-${safeEventId}-review.json`),
        JSON.stringify(sanitizeEvidence({ eventId: safeEventId, timestamp: entry.at, text: entry.text, source: "incident-review-log" }), null, 2),
      );
    }
    for (const [log, lines] of Object.entries(logLines)) {
      await mkdir(path.join(destination, "logs"), { recursive: true });
      await writeAtomic(path.join(destination, "logs", `${log}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
    }
    // Link back to each source session's own integrity record, when it has one.
    for (const session of sessions) {
      const safeSessionId = safeIdentifier(session.id, "session id");
      const integrity: Record<string, unknown> = { schemaVersion: 1, sessionId: safeSessionId, lifecycle: session.lifecycle ?? session.status };
      for (const name of ["manifest.json", "finalization.json", "SHA256SUMS.txt"]) {
        try {
          const file = path.join(session.path, name);
          const details = await stat(file);
          integrity[name] = { bytes: details.size, sha256: await sha256File(file) };
        } catch {
          // Not finalized yet.
        }
      }
      await writeAtomic(path.join(destination, "source-context", safeSessionId, "integrity.json"), JSON.stringify(integrity, null, 2));
    }
  }

  private async writeIncidentEventHistory(sessions: readonly EvidenceSession[], eventId: string, destination: string): Promise<void> {
    const target = path.join(destination, "events", "history.jsonl");
    await writeAtomic(target, "");
    for (const session of sessions) {
      const source = path.join(session.path, "events", "events.jsonl");
      try {
        for await (const entry of boundedJsonlRecords<{ id?: string }>(
          source,
          `Incident history for ${session.id}`,
          session.status === "recording",
        )) {
          if (entry.id === eventId) await appendFile(target, `${JSON.stringify(sanitizeEvidence({ ...entry, sourceSessionId: session.id }))}\n`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && session.eventCount === 0) continue;
        throw error;
      }
    }
  }

  private async validateExportTree(root: string, label: string): Promise<{ legacyFrameCount: number }> {
    const files = (await walkFiles(root)).map(archivePath);
    let legacyFrameCount = 0;
    for (const relativePath of files.filter((candidate) => candidate.endsWith(".jsonl"))) {
      const source = path.join(root, ...relativePath.split("/"));
      if (relativePath === "spectrum/frames.jsonl") {
        const rawSizes = new Map<string, number>();
        for await (const indexed of boundedJsonlRecords<Record<string, unknown>>(source, `${label} spectrum index`, false)) {
          const decoded = this.decodeIndexedFrameRecord(indexed, `${label} spectrum index`);
          if (decoded.legacy) legacyFrameCount += 1;
          let rawSize = rawSizes.get(decoded.rawFile);
          if (rawSize === undefined) {
            const rawPath = this.resolveWithin(root, decoded.rawFile);
            try {
              rawSize = (await stat(rawPath)).size;
            } catch {
              throw new EvidenceCorruptionError(`${label} spectrum index references missing raw evidence ${decoded.rawFile}`);
            }
            rawSizes.set(decoded.rawFile, rawSize);
          }
          if (decoded.rawOffset + decoded.rawLength > rawSize) {
            throw new EvidenceCorruptionError(`${label} spectrum index points beyond ${decoded.rawFile}`);
          }
        }
        continue;
      }
      for await (const _record of boundedJsonlRecords<unknown>(source, `${label} ${relativePath}`, false)) {
        // Parsing the complete stream is the validation. No records are retained.
      }
    }
    return { legacyFrameCount };
  }

  private resolveWithin(root: string, relativePath: string): string {
    if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0")) throw new Error("Evidence index contains an invalid relative path");
    const resolved = path.resolve(root, ...relativePath.split("/"));
    const relative = path.relative(path.resolve(root), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence index path leaves its source session");
    return resolved;
  }

  private async preserveRawTail(
    session: EvidenceSession,
    relativePath: string,
    start: number,
    size: number,
    recoveredAt: string,
  ): Promise<RecoveredJsonlTail | undefined> {
    if (start >= size) return undefined;
    const source = this.resolveWithin(session.path, relativePath);
    const recoveryDirectory = path.join(session.path, "recovery");
    await mkdir(recoveryDirectory, { recursive: true });
    const safeSource = relativePath.replaceAll("/", "__").replaceAll("\\", "__");
    const preservedName = `${safeTimestamp(recoveredAt)}-${safeSource}.unindexed-tail.bin`;
    const preservedPath = path.join(recoveryDirectory, preservedName);
    await pipeline(
      createReadStream(source, { start, end: size - 1 }),
      createWriteStream(preservedPath, { flags: "wx", mode: 0o640 }),
    );
    const output = await open(source, "r+");
    try {
      await output.truncate(start);
      await output.sync();
    } finally {
      await output.close();
    }
    return {
      source: relativePath,
      preservedAs: path.posix.join("recovery", preservedName),
      bytes: size - start,
    };
  }

  private async reconcileInterruptedRawEvidence(
    session: EvidenceSession,
    recoveredAt: string,
  ): Promise<{ frameCount: number; recoveredTails: RecoveredJsonlTail[]; incompleteReasons: string[] }> {
    const referencedEnds = new Map<string, number>();
    let frameCount = 0;
    const indexPath = path.join(session.path, "spectrum", "frames.jsonl");
    try {
      for await (const indexed of boundedJsonlRecords<Record<string, unknown>>(indexPath, `Recovered spectrum index for ${session.id}`, false)) {
        const decoded = this.decodeIndexedFrameRecord(indexed, `Recovered spectrum index for ${session.id}`);
        frameCount += 1;
        referencedEnds.set(decoded.rawFile, Math.max(referencedEnds.get(decoded.rawFile) ?? 0, decoded.rawOffset + decoded.rawLength));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { frameCount: 0, recoveredTails: [], incompleteReasons: ["corrupt-spectrum-index"] };
      }
    }

    const recoveredTails: RecoveredJsonlTail[] = [];
    const incompleteReasons: string[] = [];
    const rawRoot = path.join(session.path, "spectrum", "raw");
    let rawFiles: string[] = [];
    try {
      rawFiles = (await walkFiles(rawRoot)).map((relative) => path.posix.join("spectrum", "raw", archivePath(relative)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const present = new Set(rawFiles);
    for (const [relativePath, referencedEnd] of referencedEnds) {
      if (!present.has(relativePath)) {
        incompleteReasons.push(`missing-raw-evidence:${relativePath}`);
        continue;
      }
      const size = (await stat(this.resolveWithin(session.path, relativePath))).size;
      if (size < referencedEnd) {
        incompleteReasons.push(`truncated-raw-evidence:${relativePath}`);
        continue;
      }
      const recovered = await this.preserveRawTail(session, relativePath, referencedEnd, size, recoveredAt);
      if (recovered) recoveredTails.push(recovered);
    }
    for (const relativePath of rawFiles) {
      if (referencedEnds.has(relativePath)) continue;
      const size = (await stat(this.resolveWithin(session.path, relativePath))).size;
      const recovered = await this.preserveRawTail(session, relativePath, 0, size, recoveredAt);
      if (recovered) recoveredTails.push(recovered);
    }
    if (recoveredTails.length) incompleteReasons.push("quarantined-unindexed-raw-tail");
    return { frameCount, recoveredTails, incompleteReasons };
  }

  private async sessionDataBytes(sessionPath: string): Promise<number> {
    const excluded = new Set(["session.json", "manifest.json", "SHA256SUMS.txt"]);
    const files = (await walkFiles(sessionPath)).map(archivePath).filter((relativePath) => !excluded.has(relativePath));
    const sizes = await Promise.all(files.map((relativePath) => stat(path.join(sessionPath, ...relativePath.split("/")))));
    return sizes.reduce((total, details) => total + details.size, 0);
  }

  private async recoverInterruptedSessions(interruption?: EvidenceInterruptionContext): Promise<void> {
    const sessions = await this.listSessions();
    for (const session of sessions) {
      if (session.lifecycle === "Corrupt") continue;
      if (session.lifecycle === "Complete" || session.lifecycle === "Incomplete") {
        const commit = await inspectEvidenceCommitMetadata(session.path, {
          expectedDataDomain: this.dataDomain,
          expectedSessionId: session.id,
        });
        const incompleteWithoutCommit = session.lifecycle === "Incomplete"
          && commit.outcome === "missing"
          && Boolean(session.finalizationError || session.incompleteReasons?.length);
        if (!incompleteWithoutCommit && (commit.outcome !== "committed" || commit.lifecycle !== session.lifecycle)) {
          session.lifecycle = "Corrupt";
          session.status = legacyStatusForLifecycle(session.lifecycle);
          session.evidenceGap = true;
          session.verification ??= { outcome: "not-run" };
          session.finalizationError = `Startup commit inspection failed: ${commit.reasons.join(",")}`.slice(0, 1_024);
          session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "startup-commit-inspection-failed"])];
          await this.persistSession(session);
          this.finalizerCorruptTotal += 1;
          this.finalizerLastFailure = {
            sessionId: session.id,
            at: new Date().toISOString(),
            lifecycle: "Corrupt",
            reason: session.finalizationError,
          };
        }
        continue;
      }
      if (session.lifecycle === "Finalizing") {
        const commit = await inspectEvidenceCommitMetadata(session.path, {
          expectedDataDomain: this.dataDomain,
          expectedSessionId: session.id,
        });
        if (commit.outcome === "committed") {
          if (commit.lifecycle === "Complete" || commit.lifecycle === "Incomplete") {
            session.lifecycle = commit.lifecycle;
            session.status = legacyStatusForLifecycle(session.lifecycle);
            session.finalizedAt ??= commit.committedAt;
            session.verification ??= { outcome: "not-run" };
            delete session.finalizationError;
            await this.persistSession(session);
            if (session.lifecycle === "Complete") this.finalizerCompletedTotal += 1;
            else this.finalizerIncompleteTotal += 1;
          } else {
            session.lifecycle = "Corrupt";
            session.status = legacyStatusForLifecycle(session.lifecycle);
            session.evidenceGap = true;
            session.verification ??= { outcome: "not-run" };
            session.finalizationError = "Interrupted finalization commit had an unsupported lifecycle";
            session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "interrupted-finalization-corrupt"])];
            await this.persistSession(session);
            this.finalizerCorruptTotal += 1;
            this.finalizerLastFailure = {
              sessionId: session.id,
              at: new Date().toISOString(),
              lifecycle: "Corrupt",
              reason: session.finalizationError,
            };
          }
          continue;
        }
        if (commit.outcome === "fail") {
          session.lifecycle = "Corrupt";
          session.status = legacyStatusForLifecycle(session.lifecycle);
          session.evidenceGap = true;
          session.verification ??= { outcome: "not-run" };
          session.finalizationError = `Interrupted finalization commit inspection failed: ${commit.reasons.join(",")}`.slice(0, 1_024);
          session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "interrupted-finalization-corrupt"])];
          await this.persistSession(session);
          this.finalizerCorruptTotal += 1;
          this.finalizerLastFailure = {
            sessionId: session.id,
            at: new Date().toISOString(),
            lifecycle: "Corrupt",
            reason: session.finalizationError,
          };
          continue;
        }
        await Promise.all([
          unlink(path.join(session.path, "manifest.json")).catch(() => undefined),
          unlink(path.join(session.path, "SHA256SUMS.txt")).catch(() => undefined),
          unlink(path.join(session.path, "session-final.json")).catch(() => undefined),
        ]);
        if (!session.durabilityCheckpointAt) {
          session.evidenceGap = true;
          session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "missing-durability-checkpoint"])];
          await this.persistSession(session);
        }
        const finalization = this.scheduleFinalization(session);
        if (!finalization) await this.markFinalizationRejected(session);
        else await finalization;
        continue;
      }
      if (session.status !== "recording" && session.lifecycle !== "Active") continue;
      const recoveredAt = new Date().toISOString();
      const recoveredTails: RecoveredJsonlTail[] = [];
      for (const relativePath of [
        "events/events.jsonl",
        "spectrum/frames.jsonl",
        "operations.jsonl",
        "sdrconnect-events.jsonl",
        "configuration-audit.jsonl",
      ]) {
        const recovered = await this.reconcileInterruptedJsonlTail(session, relativePath, recoveredAt);
        if (recovered) recoveredTails.push(recovered);
      }
      const recoveredJsonlTailCount = recoveredTails.length;
      const rawRecovery = await this.reconcileInterruptedRawEvidence(session, recoveredAt);
      recoveredTails.push(...rawRecovery.recoveredTails);
      session.frameCount = rawRecovery.frameCount;
      const interruptedEvents = (await this.listSessionEvents(session.id))
        .filter((event) => !event.clearedAt && event.lifecycle !== "cleared" && event.lifecycle !== "ended-unknown");
      for (const event of interruptedEvents) {
        const recoveredEvent: DetectionEvent = {
          ...event,
          lifecycle: "ended-unknown",
          endedAt: recoveredAt,
          endReason: "service-restart",
        };
        const eventLine = `${JSON.stringify(sanitizeEvidence(recoveredEvent))}\n`;
        await appendFile(path.join(session.path, "events", "events.jsonl"), eventLine);
        session.eventCount += 1;
        session.byteCount += Buffer.byteLength(eventLine);
      }
      const recoveryLine = `${JSON.stringify(sanitizeEvidence({
        timestamp: recoveredAt,
        type: "unclean-session-recovery",
        disposition: "unknown",
        evidenceGap: true,
        interruptionCause: interruption?.cause ?? "unclean-service-restart",
        interruptionRecordedAt: interruption?.at,
        affectedEventIds: interruptedEvents.map((event) => event.id),
        recoveredTails,
        message: `The prior process stopped without closing this session (${interruption?.cause ?? "unclean-service-restart"}). RF state during the restart gap is unknown.`,
      }))}\n`;
      await appendFile(path.join(session.path, "operations.jsonl"), recoveryLine);
      session.byteCount += Buffer.byteLength(recoveryLine);
      session.endedAt = recoveredAt;
      session.evidenceGap = true;
      session.incompleteReasons = [...new Set([
        ...(session.incompleteReasons ?? []),
        "unclean-service-restart",
        ...(interruption?.cause ? [`interruption:${interruption.cause}`] : []),
        ...(recoveredJsonlTailCount ? ["quarantined-jsonl-tail"] : []),
        ...rawRecovery.incompleteReasons,
      ])];
      let recoveredEventCount = 0;
      try {
        for await (const _event of boundedJsonlRecords<unknown>(
          path.join(session.path, "events", "events.jsonl"),
          `Recovered event index for ${session.id}`,
          false,
        )) recoveredEventCount += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      session.eventCount = recoveredEventCount;
      session.byteCount = await this.sessionDataBytes(session.path);
      await this.syncSessionEvidence(session);
      session.lifecycle = "Finalizing";
      session.status = legacyStatusForLifecycle(session.lifecycle);
      session.durabilityCheckpointAt = recoveredAt;
      session.finalizationStartedAt = recoveredAt;
      await this.persistSession(session);
      const finalization = this.scheduleFinalization(session);
      if (!finalization) await this.markFinalizationRejected(session);
      else await finalization;
    }
  }

  /**
   * JSONL appends are intentionally newline terminated. After an unclean stop,
   * bytes following the last newline are therefore indeterminate: they may be a
   * partially written record, or a complete record whose durability cannot be
   * established. Preserve those bytes verbatim for engineering inspection, then
   * truncate the live index before appending recovery records. This avoids ever
   * joining a recovery record onto a torn tail and turning a closed session into
   * a silently partial archive.
   */
  private async reconcileInterruptedJsonlTail(
    session: EvidenceSession,
    relativePath: string,
    recoveredAt: string,
  ): Promise<RecoveredJsonlTail | undefined> {
    const source = this.resolveWithin(session.path, relativePath);
    let details;
    try {
      details = await stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (details.size === 0) return undefined;

    const input = await open(source, "r");
    let lastNewlineOffset: number | undefined;
    try {
      const block = Buffer.allocUnsafe(64 * 1024);
      let cursor = details.size;
      while (cursor > 0) {
        const start = Math.max(0, cursor - block.byteLength);
        const length = cursor - start;
        const { bytesRead } = await input.read(block, 0, length, start);
        for (let index = bytesRead - 1; index >= 0; index -= 1) {
          if (block[index] === 0x0a) {
            lastNewlineOffset = start + index;
            cursor = 0;
            break;
          }
        }
        if (lastNewlineOffset !== undefined || start === 0) break;
        cursor = start;
      }
    } finally {
      await input.close();
    }
    const cutoff = lastNewlineOffset === undefined ? 0 : lastNewlineOffset + 1;
    if (cutoff === details.size) return undefined;

    const recoveryDirectory = path.join(session.path, "recovery");
    await mkdir(recoveryDirectory, { recursive: true });
    const safeSource = relativePath.replaceAll("/", "__").replaceAll("\\", "__");
    const preservedName = `${safeTimestamp(recoveredAt)}-${safeSource}.torn-tail.bin`;
    const preservedPath = path.join(recoveryDirectory, preservedName);
    await pipeline(
      createReadStream(source, { start: cutoff, end: details.size - 1 }),
      createWriteStream(preservedPath, { flags: "wx", mode: 0o640 }),
    );
    const output = await open(source, "r+");
    try {
      await output.truncate(cutoff);
      await output.sync();
    } finally {
      await output.close();
    }
    return {
      source: relativePath,
      preservedAs: path.posix.join("recovery", preservedName),
      bytes: details.size - cutoff,
    };
  }

  private async sessionForId(sessionId: string): Promise<EvidenceSession> {
    if (this.active?.id === sessionId) return { ...this.active };
    const sessionPath = this.pathForSession(sessionId);
    const session = JSON.parse(await readFile(path.join(sessionPath, "session.json"), "utf8")) as EvidenceSession;
    if (!session || typeof session !== "object" || typeof session.startedAt !== "string" || !Number.isFinite(Date.parse(session.startedAt))
      || (session.lifecycle !== undefined && !isEvidenceLifecycle(session.lifecycle))) {
      throw new EvidenceCorruptionError(`Session descriptor for ${sessionId} is invalid`);
    }
    return {
      ...session,
      id: sessionId,
      path: sessionPath,
      ...(session.lifecycle ? { status: legacyStatusForLifecycle(session.lifecycle) } : {}),
    };
  }

  private async loadPersistedScreenshotQuota(): Promise<void> {
    this.screenshotQuotaReady = false;
    delete this.screenshotQuotaFailure;
    const limits = this.screenshotAdmission.quotaLimits;
    try {
      const usage = await scanPersistedScreenshotUsage(this.root, {
        ...this.screenshotScan,
        globalCount: limits.globalCount,
        globalBytes: limits.globalBytes,
      });
      this.screenshotAdmission.loadCommitted(usage.records);
      this.screenshotQuotaReady = usage.complete || usage.saturated;
      if (!this.screenshotQuotaReady) {
        this.screenshotQuotaFailure = usage.failure ?? "persisted screenshot quota inspection was incomplete";
      }
    } catch (error) {
      this.screenshotQuotaFailure = error instanceof Error ? error.message : String(error);
    }
  }

  private async assertExportableSource(session: EvidenceSession): Promise<void> {
    if (session.lifecycle === "Corrupt" || session.status === "storage-error") {
      throw new EvidenceExportSourceError("EVIDENCE_SOURCE_CORRUPT", `Evidence source ${session.id} is Corrupt; export was refused`);
    }
    if (session.lifecycle === "Finalizing") {
      throw new EvidenceExportSourceError("EVIDENCE_SOURCE_FINALIZING", `Evidence source ${session.id} is Finalizing; retry after finalization`);
    }
    if (session.lifecycle !== "Complete" && session.lifecycle !== "Incomplete") {
      throw new EvidenceExportSourceError(
        "EVIDENCE_SOURCE_NOT_COMMITTED",
        `Evidence source ${session.id} is not a verified Complete or explicitly gap-labelled Incomplete session`,
      );
    }
    const incomplete = session.lifecycle === "Incomplete";
    if (incomplete && (session.evidenceGap !== true || !(session.incompleteReasons?.length))) {
      throw new EvidenceExportSourceError(
        "EVIDENCE_SOURCE_INCOMPLETE_UNLABELLED",
        `Evidence source ${session.id} is Incomplete without an explicit evidence-gap reason`,
      );
    }
    let manifestPresent = true;
    try {
      await stat(path.join(session.path, "manifest.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") manifestPresent = false;
      else throw error;
    }
    if (!manifestPresent) {
      if (!incomplete) {
        throw new EvidenceExportSourceError(
          "EVIDENCE_SOURCE_MANIFEST_MISSING",
          `Evidence source ${session.id} has no finalized manifest; export was refused`,
        );
      }
      return;
    }
    const verification = await verifyEvidenceDirectory(session.path, { expectedDataDomain: this.dataDomain });
    const verifiedAt = new Date().toISOString();
    session.verification = {
      outcome: verification.outcome === "PASS"
        ? "pass"
        : verification.outcome === "INCOMPLETE" ? "incomplete" : "fail",
      verifiedAt,
      ...(verification.reasons.length ? { reasons: verification.reasons.slice(0, 16) } : {}),
    };
    if (verification.outcome === "FAIL") {
      session.lifecycle = "Corrupt";
      session.status = legacyStatusForLifecycle(session.lifecycle);
      session.evidenceGap = true;
      session.finalizationError = `Full verification failed: ${verification.reasons.join(",")}`.slice(0, 1_024);
      session.incompleteReasons = [...new Set([...(session.incompleteReasons ?? []), "full-verification-failed"])];
      this.finalizerCorruptTotal += 1;
      this.finalizerLastFailure = {
        sessionId: session.id,
        at: verifiedAt,
        lifecycle: "Corrupt",
        reason: session.finalizationError,
      };
      await this.persistSession(session).catch(() => undefined);
      throw new EvidenceExportSourceError(
        "EVIDENCE_SOURCE_VERIFICATION_FAILED",
        `Evidence source ${session.id} failed verification: ${verification.reasons.join(",")}`,
      );
    }
    const lifecycleMatchesVerification = session.lifecycle === "Complete"
      ? verification.outcome === "PASS"
      : verification.outcome === "INCOMPLETE";
    if (!lifecycleMatchesVerification) {
      await this.persistSession(session).catch(() => undefined);
      throw new EvidenceExportSourceError(
        "EVIDENCE_SOURCE_VERIFICATION_FAILED",
        `Evidence source ${session.id} lifecycle does not match its verified manifest outcome`,
      );
    }
    await this.persistSession(session).catch(() => undefined);
  }

  private pathForSession(sessionId: string): string {
    if (!/^session-[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error("Invalid evidence session id");
    const sessionPath = path.resolve(this.root, sessionId);
    this.assertContained(sessionPath);
    return sessionPath;
  }

  private requireActive(): EvidenceSession {
    if (!this.active) throw new Error("Evidence session is not initialized");
    return this.active;
  }

  private async persistSession(session: EvidenceSession, durable = true): Promise<void> {
    this.assertContained(session.path);
    const portableSession = { ...session, path: "." };
    const destination = path.join(session.path, "session.json");
    const contents = JSON.stringify(sanitizeEvidence(portableSession), null, 2);
    if (durable) await writeAtomic(destination, contents);
    else await writeAtomicUnflushed(destination, contents);
  }

  private async checkpointSession(session: EvidenceSession, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastSessionCheckpointAt < SESSION_CHECKPOINT_INTERVAL_MS) return;
    // Active-session descriptors are crash-recovery hints. Serializing an
    // fsync for every five-second hint can block raw evidence long enough to
    // breach the two-second writer bound on otherwise healthy disks. Close,
    // rotation, export, and finalization still force the durable path.
    await this.persistSession(session, force);
    if (this.active?.id === session.id) this.lastSessionCheckpointAt = now;
  }

  private refreshActive(session: EvidenceSession): void {
    if (this.active?.id === session.id) this.active = session;
  }

  private recordingDeletionJournalPath(): string {
    return path.join(this.root, RECORDING_DELETE_JOURNAL);
  }

  private recordingDeletionQuarantine(operationId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Recording deletion operation ID is invalid");
    const quarantine = path.join(this.root, `.recording-delete-${operationId}`);
    this.assertContained(quarantine);
    return quarantine;
  }

  private async directoryBytes(directoryPath: string): Promise<number> {
    this.assertContained(directoryPath);
    let total = 0;
    for (const relativePath of await walkFiles(directoryPath)) {
      const bytes = (await stat(path.join(directoryPath, relativePath))).size;
      if (!Number.isSafeInteger(bytes) || total > Number.MAX_SAFE_INTEGER - bytes) {
        throw new Error("Recording byte count exceeds the safe integer bound");
      }
      total += bytes;
    }
    return total;
  }

  private async injectRecordingDeletionFault(point: RecordingDeletionFaultPoint, operationId: string): Promise<void> {
    await this.recordingDeletionFaultInjector?.(point, operationId);
  }

  private async appendRecordingDeletionAudit(
    entry: RecordingDeletionResult & { actor: string; recovered?: boolean },
  ): Promise<boolean> {
    const auditPath = path.join(this.root, RECORDING_DELETE_AUDIT);
    const operationToken = `\"operationId\":\"${entry.operationId}\"`;
    try {
      const details = await stat(auditPath);
      const contents = await readFile(auditPath);
      if (contents.toString("utf8").includes(operationToken)) return true;
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), type: "recordings-delete", ...entry })}\n`;
      if (details.size >= RECORDING_DELETE_AUDIT_LIMIT) {
        const tail = contents.subarray(Math.max(0, contents.byteLength - RECORDING_DELETE_AUDIT_TAIL)).toString("utf8");
        const firstNewline = tail.indexOf("\n");
        await writeAtomic(auditPath, `${firstNewline >= 0 ? tail.slice(firstNewline + 1) : ""}${line}`);
        return true;
      }
      const handle = await open(auditPath, "a", 0o640);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.root);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeAtomic(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "recordings-delete", ...entry })}\n`);
      return true;
    }
  }

  private validateRecordingDeletionJournal(value: Record<string, unknown>): RecordingDeletionJournal {
    const sessionIds = value.sessionIds;
    const renamedSessionIds = value.renamedSessionIds;
    if (value.schemaVersion !== 1
      || typeof value.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(value.operationId)
      || value.dataDomain !== this.dataDomain
      || typeof value.actor !== "string" || value.actor.length > 128
      || typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt))
      || (value.phase !== "prepared" && value.phase !== "committed" && value.phase !== "audited")
      || !Array.isArray(sessionIds) || sessionIds.length > 100_000
      || !Array.isArray(renamedSessionIds) || renamedSessionIds.length > sessionIds.length
      || sessionIds.some((id) => typeof id !== "string" || !/^session-[A-Za-z0-9._-]+$/.test(id))
      || renamedSessionIds.some((id) => typeof id !== "string" || !sessionIds.includes(id))
      || new Set(sessionIds).size !== sessionIds.length || new Set(renamedSessionIds).size !== renamedSessionIds.length
      || !Number.isSafeInteger(value.deletedBytes) || (value.deletedBytes as number) < 0
      || !Number.isSafeInteger(value.retainedActiveSessions) || (value.retainedActiveSessions as number) < 0
      || !Number.isSafeInteger(value.retainedFinalizingSessions) || (value.retainedFinalizingSessions as number) < 0
      || !Number.isSafeInteger(value.retainedLeasedSessions) || (value.retainedLeasedSessions as number) < 0) {
      throw new EvidenceCorruptionError("Recording deletion journal is invalid");
    }
    return value as unknown as RecordingDeletionJournal;
  }

  private async rollbackPreparedRecordingDeletion(journal: RecordingDeletionJournal): Promise<void> {
    const quarantine = this.recordingDeletionQuarantine(journal.operationId);
    for (const sessionId of [...journal.sessionIds].reverse()) {
      const quarantined = path.join(quarantine, sessionId);
      let quarantinedPresent = false;
      try {
        quarantinedPresent = (await stat(quarantined)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!quarantinedPresent) continue;
      try {
        await stat(this.pathForSession(sessionId));
        throw new Error(`Cannot restore ${sessionId}; the destination already exists`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(quarantined, this.pathForSession(sessionId));
    }
    await rm(quarantine, { recursive: true, force: true });
    await unlink(this.recordingDeletionJournalPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(this.root);
  }

  private async recoverRecordingDeletion(): Promise<void> {
    let value: Record<string, unknown>;
    try {
      value = await this.readBoundedJsonObject(this.recordingDeletionJournalPath(), "Recording deletion journal", 8 * 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const journal = this.validateRecordingDeletionJournal(value);
    if (journal.phase === "prepared") {
      await this.rollbackPreparedRecordingDeletion(journal);
      await this.appendRecordingDeletionAudit({
        state: "refused",
        dataDomain: this.dataDomain,
        deletedSessions: 0,
        deletedBytes: 0,
        retainedActiveSessions: journal.retainedActiveSessions,
        retainedFinalizingSessions: journal.retainedFinalizingSessions,
        retainedLeasedSessions: journal.retainedLeasedSessions,
        operationId: journal.operationId,
        auditDurable: true,
        recoveryReason: "prepared-operation-rolled-back-after-restart",
        actor: journal.actor,
        recovered: true,
      });
      return;
    }
    const quarantine = this.recordingDeletionQuarantine(journal.operationId);
    for (const sessionId of journal.sessionIds) {
      try {
        await stat(this.pathForSession(sessionId));
        throw new EvidenceCorruptionError(`Committed recording deletion unexpectedly contains ${sessionId}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await this.appendRecordingDeletionAudit({
      state: "complete",
      dataDomain: this.dataDomain,
      deletedSessions: journal.sessionIds.length,
      deletedBytes: journal.deletedBytes,
      retainedActiveSessions: journal.retainedActiveSessions,
      retainedFinalizingSessions: journal.retainedFinalizingSessions,
      retainedLeasedSessions: journal.retainedLeasedSessions,
      operationId: journal.operationId,
      auditDurable: true,
      actor: journal.actor,
      recovered: journal.phase !== "audited",
    });
    await rm(quarantine, { recursive: true, force: true });
    await unlink(this.recordingDeletionJournalPath());
    await syncDirectory(this.root);
  }

  private async recoverPartialExports(): Promise<void> {
    const exportsPath = path.join(this.root, "exports");
    await mkdir(exportsPath, { recursive: true });
    const entries = (await readdir(exportsPath, { withFileTypes: true }))
      .filter((entry) => entry.name.includes(".partial-"));
    if (entries.length > 1_024) throw new Error("Export partial recovery exceeded its 1,024-entry bound");
    const removed: string[] = [];
    for (const entry of entries) {
      const candidate = path.join(exportsPath, entry.name);
      this.assertContained(candidate);
      await rm(candidate, { recursive: true, force: true });
      removed.push(entry.name.slice(0, 256));
    }
    if (removed.length) {
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "discarded-interrupted-export-partials",
        dataDomain: this.dataDomain,
        count: removed.length,
        names: removed.slice(0, 128),
        truncated: removed.length > 128,
      })}\n`;
      await appendFile(path.join(this.root, "export-recovery.jsonl"), line);
    }
  }

  private async exportCandidates(): Promise<CleanupCandidate[]> {
    const exportsPath = path.join(this.root, "exports");
    try {
      const entries = await readdir(exportsPath, { withFileTypes: true });
      const now = Date.now();
      const candidates = await Promise.all(entries.filter((entry) => (
        entry.isFile()
        || (entry.isDirectory() && entry.name.includes(".partial-") && entry.name.startsWith("."))
      )).map(async (entry): Promise<CleanupCandidate | undefined> => {
        const absolutePath = path.join(exportsPath, entry.name);
        const details = await stat(absolutePath);
        if (entry.isDirectory() && now - details.mtimeMs < STALE_EXPORT_STAGING_MS) return undefined;
        const bytes = entry.isFile()
          ? details.size
          : (await Promise.all((await walkFiles(absolutePath)).map((file) => stat(path.join(absolutePath, file)))))
              .reduce((total, item) => total + item.size, 0);
        return {
          type: "export" as const,
          id: entry.name,
          absolutePath,
          bytes,
          timestamp: details.mtimeMs,
          protected: this.exportPathProtected(absolutePath),
        };
      }));
      return candidates.filter((candidate): candidate is CleanupCandidate => candidate !== undefined);
    } catch {
      return [];
    }
  }

  private async availableBytes(): Promise<number> {
    const details = await statfs(this.root);
    const bytes = BigInt(details.bavail) * BigInt(details.bsize);
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  }

  private async ensureExportScratch(sourceBytes: number, minimumFreeBytes: number): Promise<void> {
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) {
      throw new Error("Export scratch-space inputs are invalid");
    }
    const scratchBytes = Math.min(Number.MAX_SAFE_INTEGER, sourceBytes * 2 + 64 * 1024 * 1024);
    const requiredBytes = Math.min(Number.MAX_SAFE_INTEGER, scratchBytes + minimumFreeBytes);
    const availableBytes = await this.availableBytes();
    if (availableBytes < requiredBytes) {
      throw new Error(`Export needs ${scratchBytes} bytes of scratch space while preserving the ${minimumFreeBytes}-byte disk reserve; only ${availableBytes} bytes are available`);
    }
  }

  private updateLease(leases: Map<string, number>, key: string, delta: 1 | -1): void {
    const next = (leases.get(key) ?? 0) + delta;
    if (next <= 0) leases.delete(key);
    else leases.set(key, next);
  }

  private exportPathProtected(absolutePath: string): boolean {
    const resolved = path.resolve(absolutePath);
    if (this.exportPathLeases.has(resolved)) return true;
    for (const prefix of this.activeExportPrefixes.keys()) {
      if (resolved === `${prefix}.zip` || resolved.startsWith(`${prefix}-part-`)) return true;
    }
    return false;
  }

  private assertContained(target: string): void {
    const relative = path.relative(path.resolve(this.root), path.resolve(target));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing evidence operation outside storage root: ${target}`);
    }
  }

  private async removeContained(target: string): Promise<void> {
    this.assertContained(target);
    await rm(target, { recursive: true, force: true });
  }

  private async appendMaintenanceLog(report: StorageMaintenanceReport): Promise<void> {
    const logPath = path.join(this.root, "maintenance.jsonl");
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...report })}\n`;
    try {
      const details = await stat(logPath);
      if (details.size >= MAINTENANCE_LOG_LIMIT) {
        const contents = await readFile(logPath);
        const tail = contents.subarray(Math.max(0, contents.byteLength - MAINTENANCE_LOG_TAIL)).toString("utf8");
        const firstNewline = tail.indexOf("\n");
        await writeFile(logPath, `${firstNewline >= 0 ? tail.slice(firstNewline + 1) : ""}${line}`);
        return;
      }
    } catch {
      // The first maintenance pass creates the log.
    }
    await appendFile(logPath, line);
  }

  /**
   * `critical` jobs (closing or rotating the session) may use the reserved slice of the bound, so a
   * saturated queue cannot stop the service from closing its evidence. The overall bound is unchanged.
   */
  private enqueue<T>(operation: () => Promise<T>, estimatedBytes = 4 * 1024, priority: WriterPriority = "normal", critical = false): Promise<T> {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0 || estimatedBytes > MAX_WRITER_BYTES) {
      return Promise.reject(new Error(`Evidence writer job must be between 1 byte and ${MAX_WRITER_BYTES} bytes`));
    }
    const health = this.getWriterHealth();
    const itemLimit = critical ? MAX_WRITER_ITEMS : WRITER_ORDINARY_MAX_ITEMS;
    const byteLimit = critical ? MAX_WRITER_BYTES : WRITER_ORDINARY_MAX_BYTES;
    if (health.queueItems >= itemLimit || health.queueBytes + estimatedBytes > byteLimit) {
      return Promise.reject(new Error("Evidence writer queue reached its 64-item/2 MiB resource bound"));
    }
    return new Promise<T>((resolve, reject) => {
      this.writerTasks.push({
        priority,
        enqueuedAt: Date.now(),
        estimatedBytes,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      void this.drainWriter();
    });
  }

  private async drainWriter(): Promise<void> {
    if (this.writerDraining) return;
    this.writerDraining = true;
    const rank: Record<WriterPriority, number> = { high: 0, normal: 1, low: 2 };
    try {
      while (this.writerTasks.length) {
        let selectedIndex = 0;
        for (let index = 1; index < this.writerTasks.length; index += 1) {
          if (rank[this.writerTasks[index].priority] < rank[this.writerTasks[selectedIndex].priority]) selectedIndex = index;
        }
        const [task] = this.writerTasks.splice(selectedIndex, 1);
        this.activeWriterTask = task;
        try {
          task.resolve(await task.operation());
        } catch (error) {
          task.reject(error);
        } finally {
          this.activeWriterTask = undefined;
        }
      }
    } finally {
      this.writerDraining = false;
      if (this.writerTasks.length) {
        void this.drainWriter();
      } else if (!this.activeWriterTask) {
        for (const resolve of this.writerIdleWaiters.splice(0)) resolve();
      }
    }
  }
}
