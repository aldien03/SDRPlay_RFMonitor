import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { parseSupportedReceiverModel, type SupportedReceiverModel } from "../shared/productContract";

export const V9_PILOT_SCHEMA_VERSION = 1 as const;
export const V9_PILOT_FRAMEWORK_VERSION = "rf-v9-controlled-pilot-1.0.0" as const;
export const V9_REQUIRED_DAYS = 30;
export const V9_MAX_DAYS = 45;

const DAY_MS = 86_400_000;
const DAY_NS = 86_400_000_000_000n;
const MAX_CLOCK_SKEW_NS = 60_000_000_000n;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_APPROVED_MAINTENANCE_MS = 12 * 60 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/;
const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const GATES = ["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"] as const;
export type V9PrerequisiteGate = typeof GATES[number];

export const V9_OPERATOR_TASKS = [
  "identify-affected-service",
  "state-first-action",
  "distinguish-simulation-field",
  "distinguish-missing-from-normal",
  "recover-receiver",
  "distinguish-fault-types",
  "find-signal-learning",
  "clear-test-data",
  "download-evidence-diagnostics",
  "keyboard-monitoring",
  "keyboard-alert-response",
  "keyboard-health",
  "keyboard-retry",
  "keyboard-notes",
  "keyboard-export",
  "keyboard-settings",
] as const;
export type V9OperatorTask = typeof V9_OPERATOR_TASKS[number];

export interface V9ReleaseBinding {
  buildId: string;
  serverBuildId: string;
  clientBuildId: string;
  sourceDigest: string;
  packageDigest: string;
  dependencyLockDigest: string;
  integrity: "release-metadata";
}

export interface V9ConfigurationBinding {
  configurationHash: string;
  catalogVersion: string;
  catalogHash: string;
  detectorVersion: string;
  detectorRuleSetId: string;
  detectorRuleHash: string;
}

export interface V9PrerequisiteReference {
  gate: V9PrerequisiteGate;
  artifactPath: string;
  artifactSha256: string;
  decision: "passed";
  completedAt: string;
  packageDigest: string;
  configurationHash: string;
  siteBindingHash: string;
  receiverSerialSha256: string;
  commissioningEpochId: string;
}

export interface V9PrerequisiteEnvelopeUnsigned {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-prerequisite-gate-result";
  gate: V9PrerequisiteGate;
  decision: "passed";
  completedAt: string;
  packageDigest: string;
  configurationHash: string;
  siteBindingHash: string;
  receiverSerialSha256: string;
  commissioningEpochId: string;
  sourceArtifacts: Array<{
    role: string;
    artifactPath: string;
    artifactSha256: string;
  }>;
}

export interface V9PrerequisiteEnvelope extends V9PrerequisiteEnvelopeUnsigned {
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    valueBase64: string;
  };
}

export interface V9SignerBinding {
  keyId: string;
  publicKeyPem: string;
  publicKeySha256: string;
  identityHash: string;
}

export interface V9PilotBinding {
  schemaVersion: typeof V9_PILOT_SCHEMA_VERSION;
  recordType: "rf-monitor-v9-controlled-pilot-binding";
  frameworkVersion: typeof V9_PILOT_FRAMEWORK_VERSION;
  pilotId: string;
  pilotStartDateUtc: string;
  initializedAt: string;
  release: V9ReleaseBinding;
  configuration: V9ConfigurationBinding;
  site: {
    siteBindingHash: string;
    deploymentIdHash: string;
  };
  receiver: {
    model: SupportedReceiverModel;
    serialSha256: string;
    installedChainFingerprintSha256: string;
  };
  commissioningEpochId: string;
  tier1TargetIds: string[];
  runtime: {
    serviceBootId: string;
    healthCollectorEpochId: string;
  };
  implementerIdentityHash: string;
  dailySigner: V9SignerBinding;
  prerequisiteWitness: V9SignerBinding;
  approvalWitness: V9SignerBinding;
  prerequisites: V9PrerequisiteReference[];
}

export interface V9OutOfBandPins {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-out-of-band-pins";
  pilotId: string;
  issuedAt: string;
  bindingSha256: string;
  approvalWitnessSpkiSha256: string;
  prerequisiteWitnessSpkiSha256: string;
  authorityReceipt: {
    artifactPath: string;
    artifactSha256: string;
  };
}

export interface V9TrustAnchors {
  /** Values copied from the independent channel, not calculated by this CLI. */
  expectedPinsSha256: string;
  expectedBindingSha256: string;
  expectedApprovalWitnessSpkiSha256: string;
  expectedPrerequisiteWitnessSpkiSha256: string;
}

export interface V9InitializationPins extends V9TrustAnchors {
  pins: V9OutOfBandPins;
}

interface V9PinReceipt {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-pin-receipt";
  confirmedAt: string;
  pinsSha256: string;
  bindingSha256: string;
  approvalWitnessSpkiSha256: string;
  prerequisiteWitnessSpkiSha256: string;
  authorityReceiptSha256: string;
}

export interface V9OutageEntry {
  outageId: string;
  dimension: "service" | "rf-data";
  classification: "unavailable" | "unknown" | "approved-maintenance";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  causeCode: string;
  actionCode: string;
  developerAssisted: boolean;
}

export interface V9IncidentEntry {
  incidentIdHash: string;
  statusAtStart: "absent" | "active";
  statusAtEnd: "active" | "complete" | "incomplete" | "corrupt";
  alertFramesExpected: number;
  alertFramesCommitted: number;
  alertFramesLost: number;
  evidenceArtifactPath?: string;
  evidenceArtifactSha256?: string;
}

export const V9_DAILY_SOURCE_KINDS = [
  "health-jsonl",
  "scheduler-timing",
  "evidence-verifier",
  "ops-supervisor",
  "outage-ledger",
  "incident-ledger",
] as const;
export type V9DailySourceKind = typeof V9_DAILY_SOURCE_KINDS[number];

export interface V9ArtifactReference {
  kind: V9DailySourceKind;
  artifactPath: string;
  artifactSha256: string;
}

interface V9DailySourceHeader {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-daily-source-header";
  pilotId: string;
  sequence: number;
  kind: V9DailySourceKind;
  periodStartedAt: string;
  periodEndedAt: string;
  derivedSectionSha256: string;
}

export interface V9TargetCoverage {
  targetId: string;
  requiredVisits: number;
  completedVisits: number;
  objectiveMetVisits: number;
  objectiveMissedVisits: number;
  unknownVisits: number;
  staleAttributionCount: number;
  optionalWorkMissCount: number;
}

export interface V9ResourceSample {
  monotonicNs: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  eventLoopP99Ms: number;
  evidenceQueueAgeMs: number;
  writerQueueItems: number;
}

export interface V9OperatorDrill {
  drillId: string;
  operatorIdentityHash: string;
  task: V9OperatorTask;
  performedAt: string;
  success: boolean;
  durationMs: number;
  developerAssisted: boolean;
  keyboardOnly: boolean;
  interpretedAsProofOfIntentOrNavigationError: boolean;
}

export interface V9OperationalProof {
  proofId: string;
  type: "backup-verification" | "restore-drill" | "restart-recovery-drill";
  scope: "pilot-site" | "isolated-recovery-host";
  performedAt: string;
  outcome: "passed" | "failed";
  developerAssisted: boolean;
  artifactPath: string;
  artifactSha256: string;
  pilotId: string;
  packageDigest: string;
  configurationHash: string;
  siteBindingHash: string;
  receiverSerialSha256: string;
  installedChainFingerprintSha256: string;
  commissioningEpochId: string;
  restoredEvidenceVerified: boolean;
}

export interface V9DailySummaryUnsigned {
  schemaVersion: typeof V9_PILOT_SCHEMA_VERSION;
  recordType: "rf-monitor-v9-daily-summary";
  frameworkVersion: typeof V9_PILOT_FRAMEWORK_VERSION;
  pilotId: string;
  manifestSha256: string;
  sequence: number;
  dayDateUtc: string;
  periodStartedAt: string;
  periodEndedAt: string;
  signedAt: string;
  monotonicStartedNs: string;
  monotonicEndedNs: string;
  previousSummarySha256: string | null;
  release: V9ReleaseBinding;
  configuration: V9ConfigurationBinding;
  siteBindingHash: string;
  receiver: V9PilotBinding["receiver"];
  commissioningEpochId: string;
  runtime: V9PilotBinding["runtime"];
  availability: {
    periodMs: number;
    approvedMaintenanceMs: number;
    serviceAvailableMs: number;
    serviceUnavailableMs: number;
    serviceUnknownMs: number;
    rfDataAvailableMs: number;
    rfDataUnavailableMs: number;
    rfDataUnknownMs: number;
  };
  outages: V9OutageEntry[];
  incidents: V9IncidentEntry[];
  sourceArtifacts: V9ArtifactReference[];
  coverage: V9TargetCoverage[];
  resources: V9ResourceSample[];
  operatorDrills: V9OperatorDrill[];
  operationalProofs: V9OperationalProof[];
  counters: {
    processRestarts: number;
    collectorRestarts: number;
    candidateChanges: number;
    configurationChanges: number;
    commissioningEpochChanges: number;
    timeRegressions: number;
    evidenceLoss: number;
    developerInterventions: number;
    qualificationFaults: string[];
  };
}

export interface V9DailySummary extends V9DailySummaryUnsigned {
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    valueBase64: string;
  };
}

interface V9JournalEntry {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-journal-entry";
  sequence: number;
  collectedAt: string;
  previousEntrySha256: string | null;
  summarySha256: string;
  summary: V9DailySummary;
}

export interface V9PilotMetrics {
  dayCount: number;
  wallElapsedMs: number;
  monotonicElapsedNs: string;
  approvedServiceDenominatorMs: number;
  serviceAvailability: number;
  rfDataAvailability: number;
  alertFramesExpected: number;
  alertFramesCommitted: number;
  alertFramesLost: number;
  objectiveConformanceByTarget: Record<string, number>;
  rssP99Bytes: number;
  rssMaxBytes: number;
  heapP99Bytes: number;
  externalP99Bytes: number;
  externalMaxBytes: number;
  eventLoopP99Ms: number;
  rssSlopeBytesPerHour: number;
  lastSevenDayRssSlopeBytesPerHour: number;
  finalFortyEightHourRssSlopeBytesPerHour: number;
  heapSlopeBytesPerHour: number;
  externalSlopeBytesPerHour: number;
  operatorCount: number;
  backupProofCount: number;
  restoreProofCount: number;
  restartRecoveryProofCount: number;
  approvedMaintenanceMs: number;
  recoveredAtomicTailCount: number;
}

export interface V9PilotEvaluation {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-controlled-pilot-evaluation";
  frameworkVersion: typeof V9_PILOT_FRAMEWORK_VERSION;
  generatedAt: string;
  pilotId: string;
  manifestSha256: string;
  pinsSha256: string;
  pinReceiptSha256: string;
  journalHeadSha256: string;
  previousEvaluationSha256: string | null;
  decision: "eligible-for-witness-review" | "failed";
  productionReady: false;
  metrics: V9PilotMetrics;
  blockers: string[];
  prerequisiteArtifactHashes: Array<{ gate: V9PrerequisiteGate; sha256: string }>;
}

export interface V9ApprovalUnsigned {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-external-witness-approval";
  pilotId: string;
  manifestSha256: string;
  pinsSha256: string;
  pinReceiptSha256: string;
  journalHeadSha256: string;
  evaluationSha256: string;
  approvedAt: string;
  decision: "approved";
  witnessKeyId: string;
  witnessIdentityHash: string;
  approvers: Array<{
    role: "release-owner" | "verifier-rf-engineer" | "operator-representative" | "site-owner";
    identityHash: string;
    approvedAt: string;
  }>;
  attestations: {
    independentWitness: true;
    reviewedArtifactHashes: true;
    noDeveloperAssistanceInScoredDrills: true;
    noQualificationDataWasShortenedOrAccelerated: true;
    limitationsAccepted: true;
  };
}

export interface V9Approval extends V9ApprovalUnsigned {
  signature: {
    algorithm: "Ed25519";
    valueBase64: string;
  };
}

export interface V9PilotFinalReport {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-controlled-pilot-final-report";
  frameworkVersion: typeof V9_PILOT_FRAMEWORK_VERSION;
  finalizedAt: string;
  pilotId: string;
  manifestSha256: string;
  pinsSha256: string;
  pinReceiptSha256: string;
  journalHeadSha256: string;
  evaluationSha256: string;
  evaluationFile: string;
  approvalSha256: string;
  gateDecision: "passed";
  productionReady: false;
  nextStep: "install-separate-production-qualification-approval";
}

export interface V9FinalCommit {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-final-commit";
  pilotId: string;
  committedAt: string;
  reportSha256: string;
  approvalSha256: string;
  checksumsSha256: string;
}

export interface V9VerifiedFinalBundle {
  verification: "verified-passed";
  verifiedAt: string;
  report: V9PilotFinalReport;
  commit: V9FinalCommit;
  commitSha256: string;
  verifiedFileCount: number;
}

export interface V9StateSnapshot {
  manifest: V9PilotBinding;
  manifestSha256: string;
  pins: V9OutOfBandPins;
  pinsSha256: string;
  pinReceipt: V9PinReceipt;
  pinReceiptSha256: string;
  entries: V9JournalEntry[];
  journalHeadSha256: string | null;
  recoveredAtomicTailCount: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalV9(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256V9(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashV9Record(value: unknown): string {
  return sha256V9(canonicalV9(value));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function validSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function finiteInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function decimalNanoseconds(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,24})$/.test(value)) throw new Error("V9 monotonic timestamp is invalid");
  return BigInt(value);
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} path is invalid`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} path escapes its evidence root`);
  }
  return normalized;
}

async function assertNoSymlinkComponents(targetPath: string, allowMissingLeaf = false): Promise<void> {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new Error(`V9 path contains a symbolic link: ${current}`);
      if (index < parts.length - 1 && !details.isDirectory()) throw new Error(`V9 path parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf && index === parts.length - 1) return;
      throw error;
    }
  }
}

async function readBoundedFile(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  await assertNoSymlinkComponents(filePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) throw new Error(`${label} exceeds its file bound`);
    const bytes = Buffer.allocUnsafe(details.size);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== bytes.length) throw new Error(`${label} changed while it was read`);
    const after = await handle.stat();
    if (after.size !== details.size || after.mtimeMs !== details.mtimeMs || after.ino !== details.ino) throw new Error(`${label} changed while it was read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedJson<T>(filePath: string, maximumBytes: number, label: string): Promise<T> {
  const bytes = await readBoundedFile(filePath, maximumBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readOptionalBoundedJson<T>(filePath: string, maximumBytes: number, label: string): Promise<T | null> {
  try {
    return await readBoundedJson<T>(filePath, maximumBytes, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hashBoundedArtifact(filePath: string, maximumBytes: number, label: string): Promise<{ bytes: number; sha256: string }> {
  await assertNoSymlinkComponents(filePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) throw new Error(`${label} exceeds its file bound`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (read.bytesRead <= 0) throw new Error(`${label} changed while it was hashed`);
      digest.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error(`${label} changed while it was hashed`);
    return { bytes: before.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readFirstJsonLine(filePath: string, label: string): Promise<unknown> {
  await assertNoSymlinkComponents(filePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead <= 0) throw new Error(`${label} source header is missing`);
    const newline = buffer.subarray(0, read.bytesRead).indexOf(0x0a);
    if (newline <= 0) throw new Error(`${label} source header exceeds 64 KiB or is incomplete`);
    let payloadByte = newline + 1 < read.bytesRead ? buffer[newline + 1] : undefined;
    if (payloadByte === undefined) {
      const one = Buffer.allocUnsafe(1);
      const next = await handle.read(one, 0, 1, newline + 1);
      payloadByte = next.bytesRead === 1 ? one[0] : undefined;
    }
    if (payloadByte === undefined || payloadByte === 0x0a || payloadByte === 0x0d) throw new Error(`${label} raw source payload is missing`);
    try { return JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { throw new Error(`${label} source header is not valid JSON`); }
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  await assertNoSymlinkComponents(path.dirname(filePath));
  await assertNoSymlinkComponents(filePath, true);
  const temporary = path.join(path.dirname(filePath), `.partial-${process.pid}-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o640);
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await link(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeExclusiveOrVerify(filePath: string, contents: string, label: string): Promise<void> {
  try {
    await writeExclusive(filePath, contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readBoundedFile(filePath, MAX_MANIFEST_BYTES, label);
    if (!existing.equals(Buffer.from(contents))) throw new Error(`${label} already exists with different contents`);
  }
}

interface V9OperationLock {
  schemaVersion: 1;
  recordType: "rf-monitor-v9-operation-lock";
  pid: number;
  operation: "collect" | "evaluate" | "finalize";
  acquiredAt: string;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withV9OperationLock<T>(stateRoot: string, operation: V9OperationLock["operation"], work: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateRoot, ".operation-lock");
  const lock: V9OperationLock = {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-operation-lock",
    pid: process.pid,
    operation,
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusive(lockPath, `${canonicalV9(lock)}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readBoundedJson<V9OperationLock>(lockPath, 4096, "V9 operation lock");
      if (!isPlainRecord(existing) || !exactKeys(existing, ["schemaVersion", "recordType", "pid", "operation", "acquiredAt", "token"]) || existing.schemaVersion !== 1 || existing.recordType !== "rf-monitor-v9-operation-lock" || !finiteInteger(existing.pid, 1, 4_194_304) || !["collect", "evaluate", "finalize"].includes(existing.operation) || !validTimestamp(existing.acquiredAt) || typeof existing.token !== "string" || !/^[a-f0-9-]{36}$/.test(existing.token)) throw new Error("V9 operation lock is invalid and requires fail-closed recovery");
      if (processIsAlive(existing.pid)) throw new Error(`V9 ${existing.operation} operation is already active`);
      const retained = path.join(stateRoot, `.partial-operation-lock-${randomUUID()}`);
      await rename(lockPath, retained);
      const directory = await open(stateRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      if (attempt === 1) throw new Error("V9 operation lock recovery raced with another process");
    }
  }
  const acquired = await readBoundedJson<V9OperationLock>(lockPath, 4096, "V9 operation lock");
  if (canonicalV9(acquired) !== canonicalV9(lock)) throw new Error("V9 operation lock ownership was lost");
  try {
    return await work();
  } finally {
    const current = await readBoundedJson<V9OperationLock>(lockPath, 4096, "V9 operation lock");
    if (canonicalV9(current) !== canonicalV9(lock)) throw new Error("V9 operation lock ownership changed");
    await unlink(lockPath);
    const directory = await open(stateRoot, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

/**
 * Publish one complete immutable file with an exclusive hard-link. A crash may
 * leave an unlinked `.partial-*` file, but can never expose a torn scored day.
 * Those retained tails are counted on recovery and excluded from qualification.
 */
async function writeAtomicExclusive(filePath: string, contents: string): Promise<void> {
  await writeExclusive(filePath, contents);
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("V9 witness keys must be Ed25519 public keys");
  return sha256V9(key.export({ type: "spki", format: "der" }));
}

function assertSigner(signer: V9SignerBinding, label: string): void {
  if (!isPlainRecord(signer) || !exactKeys(signer, ["keyId", "publicKeyPem", "publicKeySha256", "identityHash"])) throw new Error(`${label} schema is invalid`);
  if (!validSafeId(signer.keyId) || !validHash(signer.identityHash) || !validHash(signer.publicKeySha256)) throw new Error(`${label} identity is invalid`);
  if (typeof signer.publicKeyPem !== "string" || signer.publicKeyPem.length > 4096) throw new Error(`${label} public key is invalid`);
  if (publicKeyFingerprint(signer.publicKeyPem) !== signer.publicKeySha256) throw new Error(`${label} public key hash does not match`);
}

function verifyDetachedSignature(payload: unknown, signatureBase64: string, publicKeyPem: string, label: string): void {
  if (typeof signatureBase64 !== "string" || signatureBase64.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) {
    throw new Error(`${label} signature encoding is invalid`);
  }
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) throw new Error(`${label} signature length is invalid`);
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || !verifySignature(null, Buffer.from(hashV9Record(payload), "hex"), key, signature)) {
    throw new Error(`${label} signature verification failed`);
  }
}

function assertRelease(value: V9ReleaseBinding): void {
  if (!isPlainRecord(value) || !exactKeys(value, ["buildId", "serverBuildId", "clientBuildId", "sourceDigest", "packageDigest", "dependencyLockDigest", "integrity"])) throw new Error("V9 release binding schema is invalid");
  if (!validSafeId(value.buildId) || !validSafeId(value.serverBuildId) || !validSafeId(value.clientBuildId)) throw new Error("V9 release build identity is invalid");
  if (value.buildId !== value.serverBuildId || value.buildId !== value.clientBuildId || value.integrity !== "release-metadata") throw new Error("V9 requires one immutable matched release build");
  for (const digest of [value.sourceDigest, value.packageDigest, value.dependencyLockDigest]) if (!validHash(digest)) throw new Error("V9 release digest is invalid");
}

function assertConfiguration(value: V9ConfigurationBinding): void {
  if (!isPlainRecord(value) || !exactKeys(value, ["configurationHash", "catalogVersion", "catalogHash", "detectorVersion", "detectorRuleSetId", "detectorRuleHash"])) throw new Error("V9 configuration binding schema is invalid");
  if (!validHash(value.configurationHash) || !validHash(value.catalogHash) || !validHash(value.detectorRuleHash)) throw new Error("V9 configuration digest is invalid");
  if (!validSafeId(value.catalogVersion) || !validSafeId(value.detectorVersion) || !validSafeId(value.detectorRuleSetId)) throw new Error("V9 detector or catalog identity is invalid");
}

function assertBinding(binding: V9PilotBinding): void {
  if (!isPlainRecord(binding) || binding.schemaVersion !== 1 || binding.recordType !== "rf-monitor-v9-controlled-pilot-binding" || binding.frameworkVersion !== V9_PILOT_FRAMEWORK_VERSION) throw new Error("V9 pilot binding schema is invalid");
  if (!exactKeys(binding, ["schemaVersion", "recordType", "frameworkVersion", "pilotId", "pilotStartDateUtc", "initializedAt", "release", "configuration", "site", "receiver", "commissioningEpochId", "tier1TargetIds", "runtime", "implementerIdentityHash", "dailySigner", "prerequisiteWitness", "approvalWitness", "prerequisites"])) throw new Error("V9 pilot binding contains unsupported fields");
  if (!validSafeId(binding.pilotId) || !UTC_DATE_PATTERN.test(binding.pilotStartDateUtc) || !validTimestamp(binding.initializedAt)) throw new Error("V9 pilot time or identifier is invalid");
  const startMs = Date.parse(`${binding.pilotStartDateUtc}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== binding.pilotStartDateUtc || Date.parse(binding.initializedAt) > startMs) throw new Error("V9 pilot must be initialized before its first valid UTC day");
  assertRelease(binding.release);
  assertConfiguration(binding.configuration);
  if (!validHash(binding.site?.siteBindingHash) || !validHash(binding.site?.deploymentIdHash)) throw new Error("V9 site binding is invalid");
  const model = parseSupportedReceiverModel(binding.receiver?.model);
  if (!model || model !== binding.receiver.model || !validHash(binding.receiver.serialSha256) || !validHash(binding.receiver.installedChainFingerprintSha256)) throw new Error("V9 receiver binding is invalid");
  if (!validSafeId(binding.commissioningEpochId) || !validSafeId(binding.runtime?.serviceBootId) || !validSafeId(binding.runtime?.healthCollectorEpochId)) throw new Error("V9 runtime or commissioning epoch is invalid");
  if (!Array.isArray(binding.tier1TargetIds) || binding.tier1TargetIds.length !== 4 || new Set(binding.tier1TargetIds).size !== 4 || binding.tier1TargetIds.some((id) => !validSafeId(id))) throw new Error("V9 requires exactly four distinct Tier-1 targets");
  if (!validHash(binding.implementerIdentityHash)) throw new Error("V9 implementer identity hash is invalid");
  assertSigner(binding.dailySigner, "V9 daily signer");
  assertSigner(binding.prerequisiteWitness, "V9 prerequisite witness");
  assertSigner(binding.approvalWitness, "V9 approval witness");
  if (binding.approvalWitness.identityHash === binding.implementerIdentityHash) throw new Error("V9 approval witness must be independent of the implementer");
  if (binding.approvalWitness.identityHash === binding.dailySigner.identityHash) throw new Error("V9 approval witness must be independent of the daily data custodian");
  if (binding.prerequisiteWitness.identityHash === binding.implementerIdentityHash || binding.prerequisiteWitness.identityHash === binding.dailySigner.identityHash) throw new Error("V9 prerequisite witness must be independent of the implementer and daily data custodian");
  if (!Array.isArray(binding.prerequisites) || binding.prerequisites.length !== GATES.length) throw new Error("V9 requires exact V0-V8 prerequisite references");
  const seen = new Set<string>();
  for (const prerequisite of binding.prerequisites) {
    if (!isPlainRecord(prerequisite) || !exactKeys(prerequisite, ["gate", "artifactPath", "artifactSha256", "decision", "completedAt", "packageDigest", "configurationHash", "siteBindingHash", "receiverSerialSha256", "commissioningEpochId"])) throw new Error("V9 prerequisite reference schema is invalid");
    if (!GATES.includes(prerequisite.gate) || seen.has(prerequisite.gate)) throw new Error("V9 prerequisite gates are missing or duplicated");
    seen.add(prerequisite.gate);
    safeRelativePath(prerequisite.artifactPath, `V9 ${prerequisite.gate}`);
    if (prerequisite.decision !== "passed" || !validTimestamp(prerequisite.completedAt) || Date.parse(prerequisite.completedAt) > Date.parse(binding.initializedAt) || Date.parse(prerequisite.completedAt) > startMs) throw new Error(`V9 ${prerequisite.gate} prerequisite chronology is invalid`);
    if (!validHash(prerequisite.artifactSha256) || prerequisite.packageDigest !== binding.release.packageDigest || prerequisite.configurationHash !== binding.configuration.configurationHash || prerequisite.siteBindingHash !== binding.site.siteBindingHash || prerequisite.receiverSerialSha256 !== binding.receiver.serialSha256 || prerequisite.commissioningEpochId !== binding.commissioningEpochId) throw new Error(`V9 ${prerequisite.gate} prerequisite binding is stale`);
  }
}

function assertOutOfBandPins(binding: V9PilotBinding, authority: V9InitializationPins, confirmedAt: string): V9PinReceipt {
  const { pins } = authority;
  const bindingSha256 = hashV9Record(binding);
  if (!isPlainRecord(pins) || !exactKeys(pins, ["schemaVersion", "recordType", "pilotId", "issuedAt", "bindingSha256", "approvalWitnessSpkiSha256", "prerequisiteWitnessSpkiSha256", "authorityReceipt"]) || pins.schemaVersion !== 1 || pins.recordType !== "rf-monitor-v9-out-of-band-pins" || pins.pilotId !== binding.pilotId || !validTimestamp(pins.issuedAt) || Date.parse(pins.issuedAt) > Date.parse(binding.initializedAt) || pins.bindingSha256 !== bindingSha256 || !validHash(pins.approvalWitnessSpkiSha256) || !validHash(pins.prerequisiteWitnessSpkiSha256) || !isPlainRecord(pins.authorityReceipt) || !exactKeys(pins.authorityReceipt, ["artifactPath", "artifactSha256"]) || !validHash(pins.authorityReceipt.artifactSha256)) throw new Error("V9 out-of-band pin record is invalid or stale");
  safeRelativePath(pins.authorityReceipt.artifactPath, "V9 pin authority receipt");
  if (!validHash(authority.expectedPinsSha256) || hashV9Record(pins) !== authority.expectedPinsSha256) throw new Error("V9 out-of-band pin SHA-256 does not match the independently supplied value");
  if (!validHash(authority.expectedBindingSha256) || bindingSha256 !== authority.expectedBindingSha256 || pins.bindingSha256 !== authority.expectedBindingSha256) throw new Error("V9 binding SHA-256 does not match the independently supplied value");
  if (!validHash(authority.expectedApprovalWitnessSpkiSha256) || pins.approvalWitnessSpkiSha256 !== authority.expectedApprovalWitnessSpkiSha256 || binding.approvalWitness.publicKeySha256 !== authority.expectedApprovalWitnessSpkiSha256) throw new Error("V9 approval witness SPKI is not the independently pinned key");
  if (!validHash(authority.expectedPrerequisiteWitnessSpkiSha256) || pins.prerequisiteWitnessSpkiSha256 !== authority.expectedPrerequisiteWitnessSpkiSha256 || binding.prerequisiteWitness.publicKeySha256 !== authority.expectedPrerequisiteWitnessSpkiSha256) throw new Error("V9 prerequisite witness SPKI is not the independently pinned key");
  if (!validTimestamp(confirmedAt) || Date.parse(confirmedAt) < Date.parse(binding.initializedAt) || Date.parse(confirmedAt) >= dayStartMs(binding.pilotStartDateUtc)) throw new Error("V9 out-of-band pins were not confirmed before the pilot start");
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-pin-receipt",
    confirmedAt,
    pinsSha256: authority.expectedPinsSha256,
    bindingSha256: authority.expectedBindingSha256,
    approvalWitnessSpkiSha256: authority.expectedApprovalWitnessSpkiSha256,
    prerequisiteWitnessSpkiSha256: authority.expectedPrerequisiteWitnessSpkiSha256,
    authorityReceiptSha256: pins.authorityReceipt.artifactSha256,
  };
}

function assertRecoveredPins(binding: V9PilotBinding, pins: V9OutOfBandPins, receipt: V9PinReceipt): void {
  if (!isPlainRecord(receipt) || !exactKeys(receipt, ["schemaVersion", "recordType", "confirmedAt", "pinsSha256", "bindingSha256", "approvalWitnessSpkiSha256", "prerequisiteWitnessSpkiSha256", "authorityReceiptSha256"]) || receipt.schemaVersion !== 1 || receipt.recordType !== "rf-monitor-v9-pin-receipt") throw new Error("V9 persisted out-of-band pin receipt is invalid");
  const reconstructed = assertOutOfBandPins(binding, {
    pins,
    expectedPinsSha256: receipt.pinsSha256,
    expectedBindingSha256: receipt.bindingSha256,
    expectedApprovalWitnessSpkiSha256: receipt.approvalWitnessSpkiSha256,
    expectedPrerequisiteWitnessSpkiSha256: receipt.prerequisiteWitnessSpkiSha256,
  }, receipt.confirmedAt);
  if (canonicalV9(reconstructed) !== canonicalV9(receipt)) throw new Error("V9 persisted out-of-band pin receipt is invalid");
}

function assertExternalTrustAnchors(snapshot: V9StateSnapshot, anchors: V9TrustAnchors): void {
  const reconstructed = assertOutOfBandPins(snapshot.manifest, { pins: snapshot.pins, ...anchors }, snapshot.pinReceipt.confirmedAt);
  if (canonicalV9(reconstructed) !== canonicalV9(snapshot.pinReceipt)) throw new Error("V9 persisted pin receipt does not match the independently re-supplied trust anchors");
}

interface V9EvidenceByteBudget { totalBytes: number }

async function verifyReferencedArtifacts(rootPath: string, references: Array<{ artifactPath: string; artifactSha256: string }>, budget: V9EvidenceByteBudget = { totalBytes: 0 }): Promise<void> {
  await assertNoSymlinkComponents(rootPath);
  for (const reference of references) {
    const relative = safeRelativePath(reference.artifactPath, "V9 evidence");
    const absolute = path.resolve(rootPath, ...relative.split("/"));
    if (path.relative(rootPath, absolute).startsWith("..")) throw new Error("V9 evidence path escapes its root");
    const artifact = await hashBoundedArtifact(absolute, MAX_ARTIFACT_BYTES, `V9 evidence ${relative}`);
    budget.totalBytes += artifact.bytes;
    if (budget.totalBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error("V9 referenced evidence exceeds its aggregate total byte bound");
    if (artifact.sha256 !== reference.artifactSha256) throw new Error(`V9 evidence digest mismatch: ${relative}`);
  }
}

function unsignedPrerequisiteEnvelope(envelope: V9PrerequisiteEnvelope): V9PrerequisiteEnvelopeUnsigned {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

async function verifyPrerequisiteEnvelopes(evidenceRoot: string, binding: V9PilotBinding, budget: V9EvidenceByteBudget): Promise<void> {
  const requiredRoles: Partial<Record<V9PrerequisiteGate, string[]>> = {
    V7: ["health-series", "timing-report", "baseline-report"],
    V8: ["fault-matrix", "clean-soak-series", "switch-counters", "backup-restore-report"],
  };
  for (const reference of binding.prerequisites) {
    const relative = safeRelativePath(reference.artifactPath, `V9 ${reference.gate} prerequisite envelope`);
    const envelope = await readBoundedJson<V9PrerequisiteEnvelope>(path.resolve(evidenceRoot, ...relative.split("/")), MAX_MANIFEST_BYTES, `V9 ${reference.gate} prerequisite envelope`);
    if (!isPlainRecord(envelope) || !exactKeys(envelope, ["schemaVersion", "recordType", "gate", "decision", "completedAt", "packageDigest", "configurationHash", "siteBindingHash", "receiverSerialSha256", "commissioningEpochId", "sourceArtifacts", "signature"]) || envelope.schemaVersion !== 1 || envelope.recordType !== "rf-monitor-v9-prerequisite-gate-result" || envelope.gate !== reference.gate || envelope.decision !== "passed" || envelope.completedAt !== reference.completedAt || envelope.packageDigest !== binding.release.packageDigest || envelope.configurationHash !== binding.configuration.configurationHash || envelope.siteBindingHash !== binding.site.siteBindingHash || envelope.receiverSerialSha256 !== binding.receiver.serialSha256 || envelope.commissioningEpochId !== binding.commissioningEpochId || !Array.isArray(envelope.sourceArtifacts) || envelope.sourceArtifacts.length < 1 || envelope.sourceArtifacts.length > 16 || !isPlainRecord(envelope.signature) || !exactKeys(envelope.signature, ["algorithm", "keyId", "valueBase64"]) || envelope.signature.algorithm !== "Ed25519" || envelope.signature.keyId !== binding.prerequisiteWitness.keyId) throw new Error(`V9 ${reference.gate} prerequisite is not an exact witnessed PASS envelope`);
    const paths = new Set<string>();
    const roles = new Set<string>();
    for (const source of envelope.sourceArtifacts) {
      if (!isPlainRecord(source) || !exactKeys(source, ["role", "artifactPath", "artifactSha256"]) || !validSafeId(source.role) || roles.has(source.role) || !validHash(source.artifactSha256)) throw new Error(`V9 ${reference.gate} prerequisite source set is invalid`);
      const sourcePath = safeRelativePath(source.artifactPath, `V9 ${reference.gate} prerequisite source`);
      if (sourcePath === relative || paths.has(sourcePath)) throw new Error(`V9 ${reference.gate} prerequisite source set is duplicated or recursive`);
      paths.add(sourcePath);
      roles.add(source.role);
    }
    if ((requiredRoles[reference.gate] ?? ["primary-result"]).some((role) => !roles.has(role))) throw new Error(`V9 ${reference.gate} prerequisite source roles are incomplete`);
    verifyDetachedSignature(unsignedPrerequisiteEnvelope(envelope), envelope.signature.valueBase64, binding.prerequisiteWitness.publicKeyPem, `V9 ${reference.gate} prerequisite`);
    await verifyReferencedArtifacts(evidenceRoot, envelope.sourceArtifacts, budget);
  }
}

export function v9DailySourceSectionSha256(summary: V9DailySummaryUnsigned, kind: V9DailySourceKind): string {
  switch (kind) {
    case "health-jsonl":
      return hashV9Record({ availability: summary.availability, counters: summary.counters, resources: summary.resources, runtime: summary.runtime });
    case "scheduler-timing":
      return hashV9Record({ coverage: summary.coverage });
    case "evidence-verifier":
      return hashV9Record({ evidenceLoss: summary.counters.evidenceLoss, incidents: summary.incidents });
    case "ops-supervisor":
      return hashV9Record({
        candidateChanges: summary.counters.candidateChanges,
        collectorRestarts: summary.counters.collectorRestarts,
        commissioningEpochChanges: summary.counters.commissioningEpochChanges,
        configurationChanges: summary.counters.configurationChanges,
        developerInterventions: summary.counters.developerInterventions,
        operationalProofs: summary.operationalProofs,
        operatorDrills: summary.operatorDrills,
        processRestarts: summary.counters.processRestarts,
        qualificationFaults: summary.counters.qualificationFaults,
        timeRegressions: summary.counters.timeRegressions,
      });
    case "outage-ledger":
      return hashV9Record({ availability: summary.availability, outages: summary.outages });
    case "incident-ledger":
      return hashV9Record({ incidents: summary.incidents });
  }
}

async function verifyDailySourceArtifacts(evidenceRoot: string, summary: V9DailySummaryUnsigned): Promise<void> {
  for (const reference of summary.sourceArtifacts) {
    const relative = safeRelativePath(reference.artifactPath, `V9 ${reference.kind}`);
    const absolute = path.resolve(evidenceRoot, ...relative.split("/"));
    if (path.relative(evidenceRoot, absolute).startsWith("..")) throw new Error("V9 daily source path escapes its root");
    const header = await readFirstJsonLine(absolute, `V9 ${reference.kind}`) as V9DailySourceHeader;
    if (!isPlainRecord(header) || !exactKeys(header, ["schemaVersion", "recordType", "pilotId", "sequence", "kind", "periodStartedAt", "periodEndedAt", "derivedSectionSha256"]) || header.schemaVersion !== 1 || header.recordType !== "rf-monitor-v9-daily-source-header" || header.pilotId !== summary.pilotId || header.sequence !== summary.sequence || header.kind !== reference.kind || header.periodStartedAt !== summary.periodStartedAt || header.periodEndedAt !== summary.periodEndedAt || header.derivedSectionSha256 !== v9DailySourceSectionSha256(summary, reference.kind)) throw new Error(`V9 ${reference.kind} source header does not bind the signed daily metrics`);
    const rechecked = await hashBoundedArtifact(absolute, MAX_ARTIFACT_BYTES, `V9 ${reference.kind}`);
    if (rechecked.sha256 !== reference.artifactSha256) throw new Error(`V9 ${reference.kind} source artifact changed during binding verification`);
  }
}

function dayStartMs(date: string): number {
  if (!UTC_DATE_PATTERN.test(date)) throw new Error("V9 daily date is invalid");
  const value = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error("V9 daily date is invalid");
  return value;
}

function sameBinding(summary: V9DailySummaryUnsigned, binding: V9PilotBinding): boolean {
  return canonicalV9(summary.release) === canonicalV9(binding.release)
    && canonicalV9(summary.configuration) === canonicalV9(binding.configuration)
    && summary.siteBindingHash === binding.site.siteBindingHash
    && canonicalV9(summary.receiver) === canonicalV9(binding.receiver)
    && summary.commissioningEpochId === binding.commissioningEpochId
    && canonicalV9(summary.runtime) === canonicalV9(binding.runtime);
}

function assertOutages(summary: V9DailySummaryUnsigned, startMs: number, endMs: number): void {
  if (!Array.isArray(summary.outages) || summary.outages.length > 256) throw new Error("V9 daily outage ledger exceeds its bound");
  const totals = new Map<string, number>();
  const intervals = new Map<string, Array<[number, number]>>();
  const maintenanceIntervals = new Map<string, Array<[number, number]>>();
  const ids = new Set<string>();
  for (const outage of summary.outages) {
    if (!isPlainRecord(outage) || !exactKeys(outage, ["outageId", "dimension", "classification", "startedAt", "endedAt", "durationMs", "causeCode", "actionCode", "developerAssisted"]) || !validSafeId(outage.outageId) || ids.has(outage.outageId) || !["service", "rf-data"].includes(outage.dimension) || !["unavailable", "unknown", "approved-maintenance"].includes(outage.classification)) throw new Error("V9 outage ledger contains an invalid or duplicate entry");
    ids.add(outage.outageId);
    if (!validTimestamp(outage.startedAt) || !validTimestamp(outage.endedAt) || !finiteInteger(outage.durationMs, 1, DAY_MS) || !validSafeId(outage.causeCode) || !validSafeId(outage.actionCode) || typeof outage.developerAssisted !== "boolean") throw new Error("V9 outage ledger entry is invalid");
    const started = Date.parse(outage.startedAt);
    const ended = Date.parse(outage.endedAt);
    if (started < startMs || ended > endMs || ended <= started || ended - started !== outage.durationMs) throw new Error("V9 outage interval is outside its daily window");
    const key = `${outage.dimension}:${outage.classification}`;
    totals.set(key, (totals.get(key) ?? 0) + outage.durationMs);
    const dimensionIntervals = intervals.get(outage.dimension) ?? [];
    dimensionIntervals.push([started, ended]);
    intervals.set(outage.dimension, dimensionIntervals);
    if (outage.classification === "approved-maintenance") {
      const maintenance = maintenanceIntervals.get(outage.dimension) ?? [];
      maintenance.push([started, ended]);
      maintenanceIntervals.set(outage.dimension, maintenance);
    }
  }
  for (const dimensionIntervals of intervals.values()) {
    dimensionIntervals.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < dimensionIntervals.length; index += 1) if (dimensionIntervals[index][0] < dimensionIntervals[index - 1][1]) throw new Error("V9 outage intervals overlap");
  }
  const availability = summary.availability;
  if (!isPlainRecord(availability) || !exactKeys(availability, ["periodMs", "approvedMaintenanceMs", "serviceAvailableMs", "serviceUnavailableMs", "serviceUnknownMs", "rfDataAvailableMs", "rfDataUnavailableMs", "rfDataUnknownMs"]) || !Object.values(availability).every((value) => finiteInteger(value, 0, DAY_MS)) || availability.periodMs !== DAY_MS) throw new Error("V9 availability counters are invalid");
  if (availability.serviceAvailableMs + availability.serviceUnavailableMs + availability.serviceUnknownMs + availability.approvedMaintenanceMs !== DAY_MS) throw new Error("V9 service availability does not reconcile");
  if (availability.rfDataAvailableMs + availability.rfDataUnavailableMs + availability.rfDataUnknownMs + availability.approvedMaintenanceMs !== DAY_MS) throw new Error("V9 RF-data availability does not reconcile");
  if ((totals.get("service:unavailable") ?? 0) !== availability.serviceUnavailableMs || (totals.get("service:unknown") ?? 0) !== availability.serviceUnknownMs || (totals.get("service:approved-maintenance") ?? 0) !== availability.approvedMaintenanceMs) throw new Error("V9 service outages do not reconcile");
  if ((totals.get("rf-data:unavailable") ?? 0) !== availability.rfDataUnavailableMs || (totals.get("rf-data:unknown") ?? 0) !== availability.rfDataUnknownMs || (totals.get("rf-data:approved-maintenance") ?? 0) !== availability.approvedMaintenanceMs) throw new Error("V9 RF-data outages do not reconcile");
  const serviceMaintenance = [...(maintenanceIntervals.get("service") ?? [])].sort((left, right) => left[0] - right[0]);
  const rfMaintenance = [...(maintenanceIntervals.get("rf-data") ?? [])].sort((left, right) => left[0] - right[0]);
  if (canonicalV9(serviceMaintenance) !== canonicalV9(rfMaintenance)) throw new Error("V9 approved-maintenance intervals must match for service and RF data");
  const rfUnavailableIntervals = [...(intervals.get("rf-data") ?? [])].sort((left, right) => left[0] - right[0]);
  for (const [serviceStart, serviceEnd] of intervals.get("service") ?? []) {
    let coveredUntil = serviceStart;
    for (const [rfStart, rfEnd] of rfUnavailableIntervals) {
      if (rfEnd <= coveredUntil) continue;
      if (rfStart > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, rfEnd);
      if (coveredUntil >= serviceEnd) break;
    }
    if (coveredUntil < serviceEnd) throw new Error("V9 RF data cannot be available while the service is unavailable, unknown, or in maintenance");
  }
}

function assertIncidents(summary: V9DailySummaryUnsigned): void {
  if (!Array.isArray(summary.incidents) || summary.incidents.length > 256) throw new Error("V9 incident ledger exceeds its bound");
  const ids = new Set<string>();
  for (const incident of summary.incidents) {
    if (!isPlainRecord(incident) || !exactKeys(incident, incident.statusAtEnd === "complete" ? ["incidentIdHash", "statusAtStart", "statusAtEnd", "alertFramesExpected", "alertFramesCommitted", "alertFramesLost", "evidenceArtifactPath", "evidenceArtifactSha256"] : ["incidentIdHash", "statusAtStart", "statusAtEnd", "alertFramesExpected", "alertFramesCommitted", "alertFramesLost"]) || !validHash(incident.incidentIdHash) || ids.has(incident.incidentIdHash) || !["absent", "active"].includes(incident.statusAtStart) || !["active", "complete", "incomplete", "corrupt"].includes(incident.statusAtEnd)) throw new Error("V9 incident ledger contains an invalid entry");
    ids.add(incident.incidentIdHash);
    if (![incident.alertFramesExpected, incident.alertFramesCommitted, incident.alertFramesLost].every((value) => finiteInteger(value, 0, 1_000_000_000)) || incident.alertFramesExpected !== incident.alertFramesCommitted + incident.alertFramesLost) throw new Error("V9 incident evidence counters do not reconcile");
    if (incident.statusAtEnd === "complete" && (!validHash(incident.evidenceArtifactSha256) || !incident.evidenceArtifactPath)) throw new Error("V9 completed incident lacks a verified evidence artifact reference");
    if (incident.statusAtEnd === "complete") safeRelativePath(incident.evidenceArtifactPath, "V9 incident evidence");
    if (incident.statusAtEnd !== "complete" && (incident.evidenceArtifactSha256 !== undefined || incident.evidenceArtifactPath !== undefined)) throw new Error("V9 non-complete incident cannot claim a final evidence artifact");
  }
}

function assertDailySourceArtifacts(summary: V9DailySummaryUnsigned): void {
  if (!Array.isArray(summary.sourceArtifacts) || summary.sourceArtifacts.length !== V9_DAILY_SOURCE_KINDS.length) throw new Error("V9 daily source artifact set is incomplete");
  const kinds = new Set<V9DailySourceKind>();
  const paths = new Set<string>();
  for (const artifact of summary.sourceArtifacts) {
    if (!isPlainRecord(artifact) || !exactKeys(artifact, ["kind", "artifactPath", "artifactSha256"]) || !V9_DAILY_SOURCE_KINDS.includes(artifact.kind) || kinds.has(artifact.kind) || !validHash(artifact.artifactSha256)) throw new Error("V9 daily source artifact is invalid or duplicated");
    const relative = safeRelativePath(artifact.artifactPath, `V9 ${artifact.kind}`);
    if (paths.has(relative)) throw new Error("V9 daily source artifact paths must be distinct");
    kinds.add(artifact.kind);
    paths.add(relative);
  }
  if (V9_DAILY_SOURCE_KINDS.some((kind) => !kinds.has(kind))) throw new Error("V9 daily source artifact set is incomplete");
}

function assertCoverage(summary: V9DailySummaryUnsigned, binding: V9PilotBinding): void {
  if (!Array.isArray(summary.coverage) || summary.coverage.length !== binding.tier1TargetIds.length) throw new Error("V9 Tier-1 coverage is incomplete");
  const byTarget = new Map(summary.coverage.map((target) => [target.targetId, target]));
  if (byTarget.size !== binding.tier1TargetIds.length || binding.tier1TargetIds.some((targetId) => !byTarget.has(targetId))) throw new Error("V9 Tier-1 target binding changed");
  for (const target of summary.coverage) {
    if (!isPlainRecord(target) || !exactKeys(target, ["targetId", "requiredVisits", "completedVisits", "objectiveMetVisits", "objectiveMissedVisits", "unknownVisits", "staleAttributionCount", "optionalWorkMissCount"])) throw new Error("V9 Tier-1 coverage schema is invalid");
    const counters = [target.requiredVisits, target.completedVisits, target.objectiveMetVisits, target.objectiveMissedVisits, target.unknownVisits, target.staleAttributionCount, target.optionalWorkMissCount];
    if (!validSafeId(target.targetId) || !counters.every((value) => finiteInteger(value, 0, 10_000_000)) || target.requiredVisits <= 0 || target.completedVisits !== target.objectiveMetVisits + target.objectiveMissedVisits || target.requiredVisits !== target.completedVisits + target.unknownVisits) throw new Error("V9 Tier-1 coverage counters do not reconcile");
  }
}

function assertResources(summary: V9DailySummaryUnsigned, startNs: bigint, endNs: bigint): void {
  if (!Array.isArray(summary.resources) || summary.resources.length !== 288) throw new Error("V9 requires exactly 288 five-minute resource samples per day");
  let previous = -1n;
  for (const sample of summary.resources) {
    if (!isPlainRecord(sample) || !exactKeys(sample, ["monotonicNs", "rssBytes", "heapUsedBytes", "externalBytes", "eventLoopP99Ms", "evidenceQueueAgeMs", "writerQueueItems"])) throw new Error("V9 resource sample schema is invalid");
    const at = decimalNanoseconds(sample.monotonicNs);
    if (at < startNs || at > endNs || at <= previous) throw new Error("V9 resource sample time is outside its window or regressed");
    previous = at;
    if (![sample.rssBytes, sample.heapUsedBytes, sample.externalBytes].every((value) => finiteInteger(value, 0, 8 * 1024 * 1024 * 1024)) || !Number.isFinite(sample.eventLoopP99Ms) || sample.eventLoopP99Ms < 0 || sample.eventLoopP99Ms > 60_000 || !finiteInteger(sample.evidenceQueueAgeMs, 0, DAY_MS) || !finiteInteger(sample.writerQueueItems, 0, 1_000_000)) throw new Error("V9 resource sample is invalid");
  }
  const first = decimalNanoseconds(summary.resources[0].monotonicNs);
  const last = decimalNanoseconds(summary.resources.at(-1)!.monotonicNs);
  if (first - startNs > 60_000_000_000n || endNs - last < 240_000_000_000n || endNs - last > 360_000_000_000n) throw new Error("V9 five-minute resource samples do not cover the daily boundaries");
  for (let index = 1; index < summary.resources.length; index += 1) {
    const prior = decimalNanoseconds(summary.resources[index - 1].monotonicNs);
    const current = decimalNanoseconds(summary.resources[index].monotonicNs);
    if (current - prior < 240_000_000_000n || current - prior > 360_000_000_000n) throw new Error("V9 resource sample cadence is outside four-to-six minutes");
  }
}

function assertDrills(summary: V9DailySummaryUnsigned, startMs: number, endMs: number): void {
  if (!Array.isArray(summary.operatorDrills) || summary.operatorDrills.length > 256) throw new Error("V9 operator drill ledger exceeds its bound");
  const ids = new Set<string>();
  for (const drill of summary.operatorDrills) {
    if (!isPlainRecord(drill) || !exactKeys(drill, ["drillId", "operatorIdentityHash", "task", "performedAt", "success", "durationMs", "developerAssisted", "keyboardOnly", "interpretedAsProofOfIntentOrNavigationError"]) || !validSafeId(drill.drillId) || ids.has(drill.drillId) || !validHash(drill.operatorIdentityHash) || !V9_OPERATOR_TASKS.includes(drill.task) || !validTimestamp(drill.performedAt) || Date.parse(drill.performedAt) < startMs || Date.parse(drill.performedAt) >= endMs || !finiteInteger(drill.durationMs, 0, 3_600_000) || typeof drill.success !== "boolean" || typeof drill.developerAssisted !== "boolean" || typeof drill.keyboardOnly !== "boolean" || typeof drill.interpretedAsProofOfIntentOrNavigationError !== "boolean") throw new Error("V9 operator drill entry is invalid");
    ids.add(drill.drillId);
  }
}

function assertProofs(summary: V9DailySummaryUnsigned, binding: V9PilotBinding, startMs: number, endMs: number): void {
  if (!Array.isArray(summary.operationalProofs) || summary.operationalProofs.length > 64) throw new Error("V9 operational proof ledger exceeds its bound");
  const ids = new Set<string>();
  for (const proof of summary.operationalProofs) {
    if (!isPlainRecord(proof) || !exactKeys(proof, ["proofId", "type", "scope", "performedAt", "outcome", "developerAssisted", "artifactPath", "artifactSha256", "pilotId", "packageDigest", "configurationHash", "siteBindingHash", "receiverSerialSha256", "installedChainFingerprintSha256", "commissioningEpochId", "restoredEvidenceVerified"]) || !validSafeId(proof.proofId) || ids.has(proof.proofId) || !["backup-verification", "restore-drill", "restart-recovery-drill"].includes(proof.type) || !["pilot-site", "isolated-recovery-host"].includes(proof.scope) || !validTimestamp(proof.performedAt) || Date.parse(proof.performedAt) < startMs || Date.parse(proof.performedAt) >= endMs || !["passed", "failed"].includes(proof.outcome) || typeof proof.developerAssisted !== "boolean" || !validHash(proof.artifactSha256) || proof.pilotId !== binding.pilotId || proof.packageDigest !== binding.release.packageDigest || proof.configurationHash !== binding.configuration.configurationHash || proof.siteBindingHash !== binding.site.siteBindingHash || proof.receiverSerialSha256 !== binding.receiver.serialSha256 || proof.installedChainFingerprintSha256 !== binding.receiver.installedChainFingerprintSha256 || proof.commissioningEpochId !== binding.commissioningEpochId || typeof proof.restoredEvidenceVerified !== "boolean") throw new Error("V9 operational proof is invalid or stale");
    safeRelativePath(proof.artifactPath, "V9 operational proof");
    if (proof.type === "restart-recovery-drill" && proof.scope !== "isolated-recovery-host") throw new Error("V9 restart drill must not restart the live pilot process");
    ids.add(proof.proofId);
  }
}

function unsignedDaily(summary: V9DailySummary): V9DailySummaryUnsigned {
  const { signature: _signature, ...unsigned } = summary;
  return unsigned;
}

function assertDailySummary(summary: V9DailySummary, snapshot: Pick<V9StateSnapshot, "manifest" | "manifestSha256" | "entries">, nowMs: number): void {
  const binding = snapshot.manifest;
  if (!isPlainRecord(summary) || summary.schemaVersion !== 1 || summary.recordType !== "rf-monitor-v9-daily-summary" || summary.frameworkVersion !== V9_PILOT_FRAMEWORK_VERSION) throw new Error("V9 daily summary schema is invalid");
  if (!exactKeys(summary, ["schemaVersion", "recordType", "frameworkVersion", "pilotId", "manifestSha256", "sequence", "dayDateUtc", "periodStartedAt", "periodEndedAt", "signedAt", "monotonicStartedNs", "monotonicEndedNs", "previousSummarySha256", "release", "configuration", "siteBindingHash", "receiver", "commissioningEpochId", "runtime", "availability", "outages", "incidents", "sourceArtifacts", "coverage", "resources", "operatorDrills", "operationalProofs", "counters", "signature"])) throw new Error("V9 daily summary contains unsupported fields");
  const unsigned = unsignedDaily(summary);
  const expectedSequence = snapshot.entries.length + 1;
  if (summary.pilotId !== binding.pilotId || summary.manifestSha256 !== snapshot.manifestSha256 || summary.sequence !== expectedSequence || summary.sequence > V9_MAX_DAYS) throw new Error("V9 daily summary belongs to another pilot or sequence");
  const expectedStart = dayStartMs(binding.pilotStartDateUtc) + (expectedSequence - 1) * DAY_MS;
  const expectedDate = new Date(expectedStart).toISOString().slice(0, 10);
  if (summary.dayDateUtc !== expectedDate || summary.periodStartedAt !== new Date(expectedStart).toISOString() || summary.periodEndedAt !== new Date(expectedStart + DAY_MS).toISOString()) throw new Error("V9 daily summary is not one complete consecutive UTC day");
  if (!validTimestamp(summary.signedAt) || Date.parse(summary.signedAt) < expectedStart + DAY_MS || Date.parse(summary.signedAt) > expectedStart + DAY_MS + 6 * 60 * 60 * 1000 || Date.parse(summary.signedAt) > nowMs) throw new Error("V9 daily summary was not signed in its daily custody window");
  if (nowMs < expectedStart + DAY_MS) throw new Error("V9 cannot collect a future or incomplete day");
  const startNs = decimalNanoseconds(summary.monotonicStartedNs);
  const endNs = decimalNanoseconds(summary.monotonicEndedNs);
  const monotonicDuration = endNs - startNs;
  if (monotonicDuration < DAY_NS || monotonicDuration > DAY_NS + MAX_CLOCK_SKEW_NS) throw new Error("V9 monotonic day does not cover a full real day");
  const previousSummary = snapshot.entries.at(-1);
  if (summary.previousSummarySha256 !== (previousSummary?.summarySha256 ?? null)) throw new Error("V9 daily summary hash chain is broken");
  if (previousSummary) {
    const previousEnd = decimalNanoseconds(previousSummary.summary.monotonicEndedNs);
    if (startNs !== previousEnd) throw new Error("V9 monotonic daily windows are not exactly contiguous");
  }
  if (!sameBinding(unsigned, binding)) throw new Error("V9 release, configuration, site, receiver, runtime, or epoch binding changed");
  assertOutages(unsigned, expectedStart, expectedStart + DAY_MS);
  assertIncidents(unsigned);
  assertDailySourceArtifacts(unsigned);
  assertCoverage(unsigned, binding);
  assertResources(unsigned, startNs, endNs);
  assertDrills(unsigned, expectedStart, expectedStart + DAY_MS);
  assertProofs(unsigned, binding, expectedStart, expectedStart + DAY_MS);
  if (!isPlainRecord(summary.counters) || !exactKeys(summary.counters, ["processRestarts", "collectorRestarts", "candidateChanges", "configurationChanges", "commissioningEpochChanges", "timeRegressions", "evidenceLoss", "developerInterventions", "qualificationFaults"]) || ![summary.counters.processRestarts, summary.counters.collectorRestarts, summary.counters.candidateChanges, summary.counters.configurationChanges, summary.counters.commissioningEpochChanges, summary.counters.timeRegressions, summary.counters.evidenceLoss, summary.counters.developerInterventions].every((value) => finiteInteger(value, 0, 1_000_000)) || !Array.isArray(summary.counters.qualificationFaults) || summary.counters.qualificationFaults.length > 64 || summary.counters.qualificationFaults.some((code) => !validSafeId(code))) throw new Error("V9 qualification counters are invalid");
  if (!isPlainRecord(summary.signature) || !exactKeys(summary.signature, ["algorithm", "keyId", "valueBase64"]) || summary.signature.algorithm !== "Ed25519" || summary.signature.keyId !== binding.dailySigner.keyId) throw new Error("V9 daily signer changed");
  verifyDetachedSignature(unsigned, summary.signature.valueBase64, binding.dailySigner.publicKeyPem, "V9 daily summary");
}

function validateIncidentContinuity(entries: V9JournalEntry[]): string[] {
  const blockers: string[] = [];
  let active = new Set<string>();
  const completed = new Set<string>();
  for (const entry of entries) {
    const next = new Set<string>();
    for (const incident of entry.summary.incidents) {
      const wasActive = active.has(incident.incidentIdHash);
      if (incident.statusAtStart === "absent" && completed.has(incident.incidentIdHash)) blockers.push("incident-ledger-duplicate-open");
      if ((incident.statusAtStart === "active") !== wasActive) blockers.push("incident-ledger-continuity-failed");
      if (incident.statusAtStart === "absent" && wasActive) blockers.push("incident-ledger-duplicate-open");
      if (incident.statusAtEnd === "active") next.add(incident.incidentIdHash);
      if (incident.statusAtEnd !== "active") completed.add(incident.incidentIdHash);
      if (incident.statusAtEnd === "incomplete" || incident.statusAtEnd === "corrupt") blockers.push("incident-evidence-not-complete");
      if (incident.alertFramesLost > 0) blockers.push("alert-evidence-loss");
    }
    for (const id of active) if (!entry.summary.incidents.some((incident) => incident.incidentIdHash === id)) blockers.push("active-incident-missing-from-daily-ledger");
    active = next;
  }
  if (active.size) blockers.push("active-incidents-not-finalized");
  return blockers;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function linearSlopeBytesPerHour(samples: Array<{ at: bigint; value: number }>): number {
  if (samples.length < 2) return 0;
  const origin = samples[0].at;
  const xs = samples.map((sample) => Number(sample.at - origin) / 3_600_000_000_000);
  const ys = samples.map((sample) => sample.value);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  if (denominator <= 0) return 0;
  return xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0) / denominator;
}

function taskRate(drills: V9OperatorDrill[], task: V9OperatorTask, maximumDurationMs?: number): number {
  const relevant = drills.filter((drill) => drill.task === task);
  if (!relevant.length) return 0;
  const byOperator = new Map<string, V9OperatorDrill[]>();
  for (const drill of relevant) byOperator.set(drill.operatorIdentityHash, [...(byOperator.get(drill.operatorIdentityHash) ?? []), drill]);
  const passed = [...byOperator.values()].filter((attempts) => attempts.length === 1 && attempts[0].success && !attempts[0].developerAssisted && (maximumDurationMs === undefined || attempts[0].durationMs <= maximumDurationMs)).length;
  return passed / byOperator.size;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function computeEvaluation(snapshot: V9StateSnapshot, generatedAt: string, previousEvaluationSha256: string | null, includeCanonicalThirtyDayWindow = true): V9PilotEvaluation {
  // Every signed day through this evaluation is scored. A pilot may extend
  // past day 30 to close an active incident, but later outages/faults can never
  // be hidden by evaluating only an earlier prefix.
  const entries = snapshot.entries;
  const blockers: string[] = [];
  if (snapshot.entries.length < V9_REQUIRED_DAYS) blockers.push("thirty-complete-days-missing");
  if (!snapshot.journalHeadSha256) blockers.push("daily-journal-empty");
  if (snapshot.recoveredAtomicTailCount > 0) blockers.push("atomic-persistence-tail-retained");
  const availability = entries.map((entry) => entry.summary.availability);
  const denominator = availability.reduce((sum, item) => sum + item.periodMs - item.approvedMaintenanceMs, 0);
  const approvedMaintenanceMs = availability.reduce((sum, item) => sum + item.approvedMaintenanceMs, 0);
  const serviceAvailable = availability.reduce((sum, item) => sum + item.serviceAvailableMs, 0);
  const rfDataAvailable = availability.reduce((sum, item) => sum + item.rfDataAvailableMs, 0);
  const serviceRatio = denominator > 0 ? serviceAvailable / denominator : 0;
  const rfRatio = denominator > 0 ? rfDataAvailable / denominator : 0;
  if (serviceRatio < 0.9995) blockers.push("service-availability-below-99.95-percent");
  if (rfRatio < 0.999) blockers.push("rf-data-availability-below-99.9-percent");
  if (approvedMaintenanceMs > MAX_APPROVED_MAINTENANCE_MS || denominator < entries.length * DAY_MS - MAX_APPROVED_MAINTENANCE_MS) blockers.push("approved-maintenance-exceeds-twelve-hour-pilot-cap");
  if (entries.some((entry) => entry.summary.outages.some((outage) => outage.developerAssisted))) blockers.push("developer-assisted-outage-recovery");
  const allOutages = entries.flatMap((entry) => entry.summary.outages);
  if (hasDuplicate(allOutages.map((outage) => outage.outageId))) blockers.push("duplicate-outage-ledger-id");
  const dailySourcePaths = entries.flatMap((entry) => entry.summary.sourceArtifacts.map((artifact) => artifact.artifactPath));
  if (hasDuplicate(dailySourcePaths)) blockers.push("daily-source-artifact-reused");
  const incidentBlockers = validateIncidentContinuity(entries);
  blockers.push(...incidentBlockers);
  const incidents = entries.flatMap((entry) => entry.summary.incidents);
  const alertExpected = incidents.reduce((sum, incident) => sum + incident.alertFramesExpected, 0);
  const alertCommitted = incidents.reduce((sum, incident) => sum + incident.alertFramesCommitted, 0);
  const alertLost = incidents.reduce((sum, incident) => sum + incident.alertFramesLost, 0);
  if (alertLost !== 0 || alertExpected !== alertCommitted) blockers.push("alert-evidence-continuity-failed");
  const counterSums = entries.reduce((totals, entry) => ({
    processRestarts: totals.processRestarts + entry.summary.counters.processRestarts,
    collectorRestarts: totals.collectorRestarts + entry.summary.counters.collectorRestarts,
    candidateChanges: totals.candidateChanges + entry.summary.counters.candidateChanges,
    configurationChanges: totals.configurationChanges + entry.summary.counters.configurationChanges,
    commissioningEpochChanges: totals.commissioningEpochChanges + entry.summary.counters.commissioningEpochChanges,
    timeRegressions: totals.timeRegressions + entry.summary.counters.timeRegressions,
    evidenceLoss: totals.evidenceLoss + entry.summary.counters.evidenceLoss,
    developerInterventions: totals.developerInterventions + entry.summary.counters.developerInterventions,
    qualificationFaults: totals.qualificationFaults + entry.summary.counters.qualificationFaults.length,
  }), { processRestarts: 0, collectorRestarts: 0, candidateChanges: 0, configurationChanges: 0, commissioningEpochChanges: 0, timeRegressions: 0, evidenceLoss: 0, developerInterventions: 0, qualificationFaults: 0 });
  if (counterSums.processRestarts) blockers.push("rf-monitor-process-restarted");
  if (counterSums.collectorRestarts) blockers.push("health-collector-restarted");
  if (counterSums.candidateChanges) blockers.push("release-candidate-changed");
  if (counterSums.configurationChanges) blockers.push("configuration-changed");
  if (counterSums.commissioningEpochChanges) blockers.push("commissioning-epoch-changed");
  if (counterSums.timeRegressions) blockers.push("time-regression-observed");
  if (counterSums.evidenceLoss) blockers.push("evidence-loss-observed");
  if (counterSums.developerInterventions) blockers.push("developer-intervention-used");
  if (counterSums.qualificationFaults) blockers.push("qualification-fault-observed");
  const coverage = Object.fromEntries(snapshot.manifest.tier1TargetIds.map((targetId) => {
    const targets = entries.map((entry) => entry.summary.coverage.find((target) => target.targetId === targetId)!);
    const required = targets.reduce((sum, target) => sum + target.requiredVisits, 0);
    const met = targets.reduce((sum, target) => sum + target.objectiveMetVisits, 0);
    if (targets.some((target) => target.staleAttributionCount > 0)) blockers.push(`stale-attribution:${targetId}`);
    if (targets.some((target) => target.optionalWorkMissCount > 0)) blockers.push(`optional-work-caused-miss:${targetId}`);
    const ratio = required > 0 ? met / required : 0;
    if (ratio < 0.999) blockers.push(`coverage-objective-below-99.9-percent:${targetId}`);
    return [targetId, ratio];
  }));
  const samples = entries.flatMap((entry) => entry.summary.resources.map((sample) => ({ at: decimalNanoseconds(sample.monotonicNs), sample })));
  const rss = samples.map(({ sample }) => sample.rssBytes);
  const heap = samples.map(({ sample }) => sample.heapUsedBytes);
  const external = samples.map(({ sample }) => sample.externalBytes);
  const eventLoop = samples.map(({ sample }) => sample.eventLoopP99Ms);
  const rssSlope = linearSlopeBytesPerHour(samples.map(({ at, sample }) => ({ at, value: sample.rssBytes })));
  const sevenDayStart = entries.length >= 7 ? decimalNanoseconds(entries.at(-7)!.summary.monotonicStartedNs) : 0n;
  const sevenDaySamples = samples.filter(({ at }) => at >= sevenDayStart);
  const sevenDaySlope = linearSlopeBytesPerHour(sevenDaySamples.map(({ at, sample }) => ({ at, value: sample.rssBytes })));
  const finalFortyEightHourStart = entries.length ? decimalNanoseconds(entries.at(-1)!.summary.monotonicEndedNs) - 48n * 3_600_000_000_000n : 0n;
  const finalFortyEightHourSamples = samples.filter(({ at }) => at >= finalFortyEightHourStart);
  const finalFortyEightHourSlope = linearSlopeBytesPerHour(finalFortyEightHourSamples.map(({ at, sample }) => ({ at, value: sample.rssBytes })));
  const heapSlope = linearSlopeBytesPerHour(samples.map(({ at, sample }) => ({ at, value: sample.heapUsedBytes })));
  const externalSlope = linearSlopeBytesPerHour(samples.map(({ at, sample }) => ({ at, value: sample.externalBytes })));
  if (percentile(rss, 0.99) >= 384 * 1024 * 1024) blockers.push("rss-p99-exceeds-384-mib");
  if (Math.max(0, ...rss) >= 448 * 1024 * 1024) blockers.push("rss-maximum-exceeds-448-mib");
  if (percentile(heap, 0.99) >= 256 * 1024 * 1024) blockers.push("heap-p99-exceeds-256-mib");
  if (percentile(external, 0.99) >= 128 * 1024 * 1024 || Math.max(0, ...external) >= 128 * 1024 * 1024) blockers.push("external-buffer-pressure-at-or-above-128-mib");
  if (percentile(eventLoop, 0.99) >= 50) blockers.push("event-loop-p99-exceeds-50-ms");
  if (rssSlope > 1024 * 1024 || sevenDaySlope > 1024 * 1024) blockers.push("rss-slope-exceeds-1-mib-per-hour");
  if (finalFortyEightHourSlope > 1024 * 1024) blockers.push("final-48-hour-rss-slope-exceeds-1-mib-per-hour");
  if (heapSlope > 1024 * 1024) blockers.push("heap-slope-exceeds-1-mib-per-hour");
  if (externalSlope > 1024 * 1024) blockers.push("external-buffer-slope-exceeds-1-mib-per-hour");
  if (samples.some(({ sample }) => sample.evidenceQueueAgeMs >= 2_000 || sample.writerQueueItems >= 64)) blockers.push("writer-or-evidence-queue-limit-breached");
  const drills = entries.flatMap((entry) => entry.summary.operatorDrills);
  if (hasDuplicate(drills.map((drill) => drill.drillId))) blockers.push("duplicate-operator-drill-id");
  if (hasDuplicate(drills.map((drill) => `${drill.operatorIdentityHash}:${drill.task}`))) blockers.push("duplicate-operator-task-attempt");
  const operatorCount = new Set(drills.map((drill) => drill.operatorIdentityHash)).size;
  if (operatorCount < 5) blockers.push("five-independent-operators-required");
  if (drills.some((drill) => drill.operatorIdentityHash === snapshot.manifest.implementerIdentityHash)) blockers.push("implementer-used-as-representative-operator");
  if (drills.some((drill) => drill.developerAssisted)) blockers.push("developer-assisted-operator-drill");
  if (drills.some((drill) => drill.interpretedAsProofOfIntentOrNavigationError)) blockers.push("unsupported-rf-claim-interpreted-by-operator");
  const rateCriteria: Array<[V9OperatorTask, number, number | undefined]> = [
    ["identify-affected-service", 0.9, 15_000],
    ["state-first-action", 0.9, 30_000],
    ["distinguish-simulation-field", 1, undefined],
    ["distinguish-missing-from-normal", 1, undefined],
    ["recover-receiver", 0.9, 180_000],
    ["distinguish-fault-types", 0.9, undefined],
    ["find-signal-learning", 0.9, 30_000],
    ["clear-test-data", 1, undefined],
    ["download-evidence-diagnostics", 0.9, undefined],
  ];
  for (const [task, minimum, duration] of rateCriteria) {
    const taskDrills = drills.filter((drill) => drill.task === task);
    if (new Set(taskDrills.map((drill) => drill.operatorIdentityHash)).size < 5) blockers.push(`operator-task-sample-incomplete:${task}`);
    if (taskRate(drills, task, duration) < minimum) blockers.push(`operator-task-criterion-failed:${task}`);
  }
  for (const task of V9_OPERATOR_TASKS.filter((candidate) => candidate.startsWith("keyboard-"))) if (!drills.some((drill) => drill.task === task && drill.keyboardOnly && drill.success && !drill.developerAssisted)) blockers.push(`keyboard-task-missing:${task}`);
  const proofs = entries.flatMap((entry) => entry.summary.operationalProofs);
  if (hasDuplicate(proofs.map((proof) => proof.proofId))) blockers.push("duplicate-operational-proof-id");
  if (hasDuplicate(proofs.map((proof) => proof.artifactPath))) blockers.push("duplicate-operational-proof-artifact");
  if (proofs.some((proof) => proof.outcome === "failed")) blockers.push("operational-proof-failed");
  if (proofs.some((proof) => proof.developerAssisted)) blockers.push("developer-assisted-operational-proof");
  const qualifyingProof = (proof: V9OperationalProof) => proof.outcome === "passed" && !proof.developerAssisted;
  const backups = proofs.filter((proof) => proof.type === "backup-verification" && qualifyingProof(proof));
  const restores = proofs.filter((proof) => proof.type === "restore-drill" && qualifyingProof(proof) && proof.restoredEvidenceVerified);
  const restarts = proofs.filter((proof) => proof.type === "restart-recovery-drill" && proof.scope === "isolated-recovery-host" && qualifyingProof(proof) && proof.restoredEvidenceVerified);
  if (backups.length < 4) blockers.push("weekly-backup-verification-missing");
  const pilotStart = dayStartMs(snapshot.manifest.pilotStartDateUtc);
  for (let week = 0; week < Math.floor(entries.length / 7); week += 1) {
    const startedAt = pilotStart + week * 7 * DAY_MS;
    const endedAt = startedAt + 7 * DAY_MS;
    if (!backups.some((proof) => Date.parse(proof.performedAt) >= startedAt && Date.parse(proof.performedAt) < endedAt)) blockers.push(`weekly-backup-verification-missing:week-${week + 1}`);
  }
  if (!restores.length) blockers.push("restore-drill-missing");
  if (!restarts.length) blockers.push("isolated-restart-recovery-drill-missing");
  const firstStart = entries.length ? Date.parse(entries[0].summary.periodStartedAt) : 0;
  const lastEnd = entries.length ? Date.parse(entries.at(-1)!.summary.periodEndedAt) : 0;
  if (entries.length >= V9_REQUIRED_DAYS && lastEnd - firstStart < V9_REQUIRED_DAYS * DAY_MS) blockers.push("wall-clock-pilot-shorter-than-thirty-days");
  const firstMono = entries.length ? decimalNanoseconds(entries[0].summary.monotonicStartedNs) : 0n;
  const lastMono = entries.length ? decimalNanoseconds(entries.at(-1)!.summary.monotonicEndedNs) : 0n;
  if (entries.length >= V9_REQUIRED_DAYS && lastMono - firstMono < BigInt(V9_REQUIRED_DAYS) * DAY_NS) blockers.push("monotonic-pilot-shorter-than-thirty-days");
  if (entries.length && (lastMono - firstMono) - BigInt(Math.max(0, lastEnd - firstStart)) * 1_000_000n > MAX_CLOCK_SKEW_NS) blockers.push("wall-and-monotonic-elapsed-time-diverged");
  if (includeCanonicalThirtyDayWindow && entries.length > V9_REQUIRED_DAYS) {
    const canonicalEntries = entries.slice(0, V9_REQUIRED_DAYS);
    const canonicalSnapshot: V9StateSnapshot = {
      ...snapshot,
      entries: canonicalEntries,
      journalHeadSha256: hashV9Record(canonicalEntries.at(-1)!),
    };
    const canonicalEvaluation = computeEvaluation(canonicalSnapshot, generatedAt, null, false);
    for (const blocker of canonicalEvaluation.blockers) {
      // An extension exists only to finish evidence for an incident that was
      // still active at the canonical boundary. Every other first-window
      // failure remains latched and cannot be diluted by later clean days.
      if (blocker !== "active-incidents-not-finalized") blockers.push(`first-thirty-days:${blocker}`);
    }
  }
  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-controlled-pilot-evaluation",
    frameworkVersion: V9_PILOT_FRAMEWORK_VERSION,
    generatedAt,
    pilotId: snapshot.manifest.pilotId,
    manifestSha256: snapshot.manifestSha256,
    pinsSha256: snapshot.pinsSha256,
    pinReceiptSha256: snapshot.pinReceiptSha256,
    journalHeadSha256: snapshot.journalHeadSha256 ?? sha256V9("v9-empty-journal"),
    previousEvaluationSha256,
    decision: uniqueBlockers.length ? "failed" : "eligible-for-witness-review",
    productionReady: false,
    metrics: {
      dayCount: entries.length,
      wallElapsedMs: Math.max(0, lastEnd - firstStart),
      monotonicElapsedNs: (lastMono - firstMono).toString(),
      approvedServiceDenominatorMs: denominator,
      serviceAvailability: serviceRatio,
      rfDataAvailability: rfRatio,
      alertFramesExpected: alertExpected,
      alertFramesCommitted: alertCommitted,
      alertFramesLost: alertLost,
      objectiveConformanceByTarget: coverage,
      rssP99Bytes: percentile(rss, 0.99),
      rssMaxBytes: Math.max(0, ...rss),
      heapP99Bytes: percentile(heap, 0.99),
      externalP99Bytes: percentile(external, 0.99),
      externalMaxBytes: Math.max(0, ...external),
      eventLoopP99Ms: percentile(eventLoop, 0.99),
      rssSlopeBytesPerHour: rssSlope,
      lastSevenDayRssSlopeBytesPerHour: sevenDaySlope,
      finalFortyEightHourRssSlopeBytesPerHour: finalFortyEightHourSlope,
      heapSlopeBytesPerHour: heapSlope,
      externalSlopeBytesPerHour: externalSlope,
      operatorCount,
      backupProofCount: backups.length,
      restoreProofCount: restores.length,
      restartRecoveryProofCount: restarts.length,
      approvedMaintenanceMs,
      recoveredAtomicTailCount: snapshot.recoveredAtomicTailCount,
    },
    blockers: uniqueBlockers,
    prerequisiteArtifactHashes: snapshot.manifest.prerequisites.map(({ gate, artifactSha256 }) => ({ gate, sha256: artifactSha256 })),
  };
}

function manifestPath(stateRoot: string): string { return path.join(stateRoot, "manifest.json"); }
function pinsPath(stateRoot: string): string { return path.join(stateRoot, "pins.json"); }
function pinReceiptPath(stateRoot: string): string { return path.join(stateRoot, "pin-receipt.json"); }
function daysPath(stateRoot: string): string { return path.join(stateRoot, "days"); }
function evaluationsPath(stateRoot: string): string { return path.join(stateRoot, "evaluations"); }
function dayFileName(sequence: number): string { return `day-${String(sequence).padStart(4, "0")}.json`; }
function finalReportPath(stateRoot: string): string { return path.join(stateRoot, "final-report.json"); }
function finalCommitPath(stateRoot: string): string { return path.join(stateRoot, "final-commit.json"); }

async function assertPilotNotFinalized(stateRoot: string): Promise<void> {
  for (const name of ["approval.json", "final-report.json", "SHA256SUMS", "final-commit.json"]) {
    const candidate = path.join(stateRoot, name);
    try {
      const details = await lstat(candidate);
      if (details.isSymbolicLink() || !details.isFile()) throw new Error(`V9 finalization path is not a regular file: ${name}`);
      throw new Error("V9 pilot is finalized or finalization has already begun");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function retainedAtomicTailCount(directoryPath: string, maximumFileBytes: number, label: string): Promise<number> {
  await assertNoSymlinkComponents(directoryPath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const retained = entries.filter((entry) => entry.name.startsWith(".partial-"));
  if (retained.some((entry) => entry.isSymbolicLink() || !entry.isFile())) throw new Error(`${label} retained atomic tail is not a regular file`);
  let totalBytes = 0;
  for (const entry of retained) {
    const details = await lstat(path.join(directoryPath, entry.name));
    if (details.size > maximumFileBytes) throw new Error(`${label} retained atomic tail exceeds its byte bound`);
    totalBytes += details.size;
  }
  if (retained.length > 16 || totalBytes > 16 * maximumFileBytes) throw new Error(`${label} retained atomic tails exceed their bound`);
  return retained.length;
}

function allEvidenceReferences(snapshot: V9StateSnapshot): Array<{ artifactPath: string; artifactSha256: string }> {
  return [
    snapshot.pins.authorityReceipt,
    ...snapshot.manifest.prerequisites,
    ...snapshot.entries.flatMap((entry) => [
      ...entry.summary.sourceArtifacts,
      ...entry.summary.operationalProofs,
      ...entry.summary.incidents.flatMap((incident) => incident.statusAtEnd === "complete" ? [{ artifactPath: incident.evidenceArtifactPath!, artifactSha256: incident.evidenceArtifactSha256! }] : []),
    ]),
  ];
}

async function verifyPilotEvidence(evidenceRoot: string, snapshot: V9StateSnapshot): Promise<void> {
  const absoluteRoot = path.resolve(evidenceRoot);
  const budget: V9EvidenceByteBudget = { totalBytes: 0 };
  await verifyReferencedArtifacts(absoluteRoot, allEvidenceReferences(snapshot), budget);
  await verifyPrerequisiteEnvelopes(absoluteRoot, snapshot.manifest, budget);
  for (const entry of snapshot.entries) await verifyDailySourceArtifacts(absoluteRoot, unsignedDaily(entry.summary));
}

export async function initializeV9Pilot(stateRoot: string, evidenceRoot: string, binding: V9PilotBinding, authority: V9InitializationPins, nowMs = Date.now()): Promise<V9StateSnapshot> {
  assertBinding(binding);
  if (Date.parse(binding.initializedAt) > nowMs) throw new Error("V9 pilot initialization is in the future");
  if (nowMs >= dayStartMs(binding.pilotStartDateUtc)) throw new Error("V9 pilot initialization must complete before the first pilot UTC day");
  if (binding.prerequisites.some((prerequisite) => Date.parse(prerequisite.completedAt) > nowMs)) throw new Error("V9 prerequisite completion is in the future at initialization");
  const pinReceipt = assertOutOfBandPins(binding, authority, new Date(nowMs).toISOString());
  await assertNoSymlinkComponents(path.dirname(path.resolve(stateRoot)));
  await assertNoSymlinkComponents(path.resolve(stateRoot), true);
  const absoluteEvidenceRoot = path.resolve(evidenceRoot);
  const evidenceBudget: V9EvidenceByteBudget = { totalBytes: 0 };
  await verifyReferencedArtifacts(absoluteEvidenceRoot, [authority.pins.authorityReceipt, ...binding.prerequisites], evidenceBudget);
  await verifyPrerequisiteEnvelopes(absoluteEvidenceRoot, binding, evidenceBudget);
  await mkdir(path.resolve(stateRoot), { recursive: false, mode: 0o750 });
  await mkdir(daysPath(stateRoot), { mode: 0o750 });
  await mkdir(evaluationsPath(stateRoot), { mode: 0o750 });
  await writeExclusive(manifestPath(stateRoot), `${canonicalV9(binding)}\n`);
  await writeExclusive(pinsPath(stateRoot), `${canonicalV9(authority.pins)}\n`);
  await writeExclusive(pinReceiptPath(stateRoot), `${canonicalV9(pinReceipt)}\n`);
  return {
    manifest: structuredClone(binding),
    manifestSha256: hashV9Record(binding),
    pins: structuredClone(authority.pins),
    pinsSha256: hashV9Record(authority.pins),
    pinReceipt,
    pinReceiptSha256: hashV9Record(pinReceipt),
    entries: [],
    journalHeadSha256: null,
    recoveredAtomicTailCount: 0,
  };
}

export async function loadV9PilotState(stateRoot: string, nowMs = Date.now()): Promise<V9StateSnapshot> {
  await assertNoSymlinkComponents(path.resolve(stateRoot));
  const binding = await readBoundedJson<V9PilotBinding>(manifestPath(stateRoot), MAX_MANIFEST_BYTES, "V9 manifest");
  assertBinding(binding);
  const manifestSha256 = hashV9Record(binding);
  const pins = await readBoundedJson<V9OutOfBandPins>(pinsPath(stateRoot), MAX_MANIFEST_BYTES, "V9 out-of-band pins");
  const pinReceipt = await readBoundedJson<V9PinReceipt>(pinReceiptPath(stateRoot), MAX_MANIFEST_BYTES, "V9 pin receipt");
  assertRecoveredPins(binding, pins, pinReceipt);
  const pinsSha256 = hashV9Record(pins);
  const pinReceiptSha256 = hashV9Record(pinReceipt);
  await assertNoSymlinkComponents(daysPath(stateRoot));
  const directoryEntries = await readdir(daysPath(stateRoot), { withFileTypes: true });
  if (directoryEntries.some((entry) => entry.isSymbolicLink())) throw new Error("V9 day directory contains a symbolic link");
  const retainedTails = await retainedAtomicTailCount(path.resolve(stateRoot), MAX_MANIFEST_BYTES, "V9 root")
    + await retainedAtomicTailCount(daysPath(stateRoot), MAX_SUMMARY_BYTES, "V9 daily journal")
    + await retainedAtomicTailCount(evaluationsPath(stateRoot), MAX_MANIFEST_BYTES, "V9 evaluation journal");
  if (retainedTails > 16) throw new Error("V9 retained atomic tails exceed their combined recovery bound");
  const names = directoryEntries
    .filter((entry) => !entry.name.startsWith(".partial-"))
    .map((entry) => {
      if (!entry.isFile() || !/^day-\d{4}\.json$/.test(entry.name)) throw new Error("V9 day directory contains an unsupported entry");
      return entry.name;
    })
    .sort();
  if (names.length > V9_MAX_DAYS) throw new Error("V9 daily journal exceeds its day bound");
  const entries: V9JournalEntry[] = [];
  let previousEntrySha256: string | null = null;
  let totalBytes = 0;
  for (const name of names) {
    if (name !== dayFileName(entries.length + 1)) throw new Error("V9 daily file sequence is missing or nonconsecutive");
    const bytes = await readBoundedFile(path.join(daysPath(stateRoot), name), MAX_SUMMARY_BYTES, `V9 ${name}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_JOURNAL_BYTES) throw new Error("V9 daily files exceed their total byte bound");
    let entry: V9JournalEntry;
    try { entry = JSON.parse(bytes.toString("utf8")) as V9JournalEntry; } catch { throw new Error("V9 daily file is not valid JSON"); }
    if (!isPlainRecord(entry) || entry.schemaVersion !== 1 || entry.recordType !== "rf-monitor-v9-journal-entry" || entry.sequence !== entries.length + 1 || entry.previousEntrySha256 !== previousEntrySha256 || !validTimestamp(entry.collectedAt) || Date.parse(entry.collectedAt) > nowMs || !validHash(entry.summarySha256)) throw new Error("V9 daily journal chain is invalid");
    const partial: V9StateSnapshot = { manifest: binding, manifestSha256, pins, pinsSha256, pinReceipt, pinReceiptSha256, entries, journalHeadSha256: previousEntrySha256, recoveredAtomicTailCount: retainedTails };
    assertDailySummary(entry.summary, partial, Math.max(nowMs, Date.parse(entry.collectedAt)));
    if (entry.summarySha256 !== hashV9Record(unsignedDaily(entry.summary))) throw new Error("V9 daily summary digest is invalid");
    previousEntrySha256 = hashV9Record(entry);
    entries.push(entry);
  }
  return { manifest: binding, manifestSha256, pins, pinsSha256, pinReceipt, pinReceiptSha256, entries, journalHeadSha256: previousEntrySha256, recoveredAtomicTailCount: retainedTails };
}

export async function verifyV9PilotEvidenceStatus(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, nowMs = Date.now()): Promise<V9StateSnapshot> {
  const snapshot = await loadV9PilotState(stateRoot, nowMs);
  assertExternalTrustAnchors(snapshot, anchors);
  await verifyPilotEvidence(evidenceRoot, snapshot);
  return snapshot;
}

async function appendV9DailySummaryUnlocked(stateRoot: string, evidenceRoot: string, summary: V9DailySummary, nowMs: number): Promise<V9StateSnapshot> {
  const snapshot = await loadV9PilotState(stateRoot, nowMs);
  await assertPilotNotFinalized(stateRoot);
  assertDailySummary(summary, snapshot, nowMs);
  const dailyReferences = [
    ...summary.sourceArtifacts,
    ...summary.operationalProofs,
    ...summary.incidents.flatMap((incident) => incident.statusAtEnd === "complete" ? [{ artifactPath: incident.evidenceArtifactPath!, artifactSha256: incident.evidenceArtifactSha256! }] : []),
  ];
  const absoluteEvidenceRoot = path.resolve(evidenceRoot);
  const evidenceBudget: V9EvidenceByteBudget = { totalBytes: 0 };
  await verifyReferencedArtifacts(absoluteEvidenceRoot, [snapshot.pins.authorityReceipt, ...snapshot.manifest.prerequisites, ...dailyReferences], evidenceBudget);
  await verifyPrerequisiteEnvelopes(absoluteEvidenceRoot, snapshot.manifest, evidenceBudget);
  await verifyDailySourceArtifacts(absoluteEvidenceRoot, unsignedDaily(summary));
  const entry: V9JournalEntry = {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-journal-entry",
    sequence: summary.sequence,
    collectedAt: new Date(nowMs).toISOString(),
    previousEntrySha256: snapshot.journalHeadSha256,
    summarySha256: hashV9Record(unsignedDaily(summary)),
    summary: structuredClone(summary),
  };
  const encoded = `${canonicalV9(entry)}\n`;
  if (Buffer.byteLength(encoded) > MAX_SUMMARY_BYTES) throw new Error("V9 daily summary exceeds its journal byte bound");
  await assertPilotNotFinalized(stateRoot);
  await writeAtomicExclusive(path.join(daysPath(stateRoot), dayFileName(entry.sequence)), encoded);
  return loadV9PilotState(stateRoot, nowMs);
}

export async function appendV9DailySummary(stateRoot: string, evidenceRoot: string, summary: V9DailySummary, nowMs = Date.now()): Promise<V9StateSnapshot> {
  return withV9OperationLock(stateRoot, "collect", () => appendV9DailySummaryUnlocked(stateRoot, evidenceRoot, summary, nowMs));
}

async function evaluateV9PilotUnlocked(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, nowMs: number, persist: boolean): Promise<V9PilotEvaluation> {
  const snapshot = await loadV9PilotState(stateRoot, nowMs);
  assertExternalTrustAnchors(snapshot, anchors);
  await assertPilotNotFinalized(stateRoot);
  await verifyPilotEvidence(evidenceRoot, snapshot);
  const nominalEnd = dayStartMs(snapshot.manifest.pilotStartDateUtc) + V9_REQUIRED_DAYS * DAY_MS;
  if (nowMs < nominalEnd) throw new Error("V9 is not run: thirty real UTC days have not elapsed");
  const attempts = await listEvaluationAttempts(stateRoot, snapshot);
  const generatedAt = new Date(nowMs).toISOString();
  const latest = attempts.at(-1);
  if (latest && generatedAt === latest.evaluation.generatedAt) {
    const recovered = computeEvaluation(snapshot, generatedAt, latest.evaluation.previousEvaluationSha256);
    if (canonicalV9(recovered) !== canonicalV9(latest.evaluation)) throw new Error("V9 evaluation retry no longer matches its immutable input");
    return latest.evaluation;
  }
  if (latest && Date.parse(generatedAt) < Date.parse(latest.evaluation.generatedAt)) throw new Error("V9 evaluation time regressed");
  const evaluation = computeEvaluation(snapshot, generatedAt, latest?.sha256 ?? null);
  if (persist) {
    const digest = hashV9Record(evaluation);
    const timestamp = evaluation.generatedAt.replace(/[^0-9]/g, "");
    await writeExclusiveOrVerify(path.join(evaluationsPath(stateRoot), `evaluation-${timestamp}-${digest.slice(0, 16)}.json`), `${canonicalV9(evaluation)}\n`, "V9 evaluation attempt");
  }
  return evaluation;
}

export async function evaluateV9Pilot(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, nowMs = Date.now(), persist = true): Promise<V9PilotEvaluation> {
  return withV9OperationLock(stateRoot, "evaluate", () => evaluateV9PilotUnlocked(stateRoot, evidenceRoot, anchors, nowMs, persist));
}

interface V9EvaluationAttempt {
  evaluation: V9PilotEvaluation;
  fileName: string;
  sha256: string;
}

function assertEvaluationSchema(evaluation: V9PilotEvaluation): void {
  if (!isPlainRecord(evaluation) || !exactKeys(evaluation, ["schemaVersion", "recordType", "frameworkVersion", "generatedAt", "pilotId", "manifestSha256", "pinsSha256", "pinReceiptSha256", "journalHeadSha256", "previousEvaluationSha256", "decision", "productionReady", "metrics", "blockers", "prerequisiteArtifactHashes"])) throw new Error("V9 evaluation-attempt schema is invalid");
  if (evaluation.schemaVersion !== 1 || evaluation.recordType !== "rf-monitor-v9-controlled-pilot-evaluation" || evaluation.frameworkVersion !== V9_PILOT_FRAMEWORK_VERSION || !["eligible-for-witness-review", "failed"].includes(evaluation.decision) || evaluation.productionReady !== false) throw new Error("V9 evaluation-attempt schema is invalid");
  const metrics = evaluation.metrics;
  const metricKeys = ["dayCount", "wallElapsedMs", "monotonicElapsedNs", "approvedServiceDenominatorMs", "serviceAvailability", "rfDataAvailability", "alertFramesExpected", "alertFramesCommitted", "alertFramesLost", "objectiveConformanceByTarget", "rssP99Bytes", "rssMaxBytes", "heapP99Bytes", "externalP99Bytes", "externalMaxBytes", "eventLoopP99Ms", "rssSlopeBytesPerHour", "lastSevenDayRssSlopeBytesPerHour", "finalFortyEightHourRssSlopeBytesPerHour", "heapSlopeBytesPerHour", "externalSlopeBytesPerHour", "operatorCount", "backupProofCount", "restoreProofCount", "restartRecoveryProofCount", "approvedMaintenanceMs", "recoveredAtomicTailCount"] as const;
  if (!isPlainRecord(metrics) || !exactKeys(metrics, metricKeys) || !finiteInteger(metrics.dayCount, 0, V9_MAX_DAYS) || !finiteInteger(metrics.wallElapsedMs, 0, V9_MAX_DAYS * DAY_MS) || typeof metrics.monotonicElapsedNs !== "string" || !/^-?(?:0|[1-9]\d{0,24})$/.test(metrics.monotonicElapsedNs)) throw new Error("V9 evaluation metrics schema is invalid");
  const numericMetrics = metricKeys.filter((key) => !["dayCount", "wallElapsedMs", "monotonicElapsedNs", "objectiveConformanceByTarget"].includes(key));
  if (numericMetrics.some((key) => typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]))) throw new Error("V9 evaluation metrics contain a non-finite value");
  if (!isPlainRecord(metrics.objectiveConformanceByTarget) || Object.values(metrics.objectiveConformanceByTarget).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("V9 evaluation target metrics are invalid");
  if (!Array.isArray(evaluation.blockers) || evaluation.blockers.length > 256 || evaluation.blockers.some((blocker) => typeof blocker !== "string" || blocker.length < 1 || blocker.length > 512)) throw new Error("V9 evaluation blockers are invalid");
  if (!Array.isArray(evaluation.prerequisiteArtifactHashes) || evaluation.prerequisiteArtifactHashes.length !== GATES.length || evaluation.prerequisiteArtifactHashes.some((item) => !isPlainRecord(item) || !exactKeys(item, ["gate", "sha256"]) || !GATES.includes(item.gate) || !validHash(item.sha256)) || new Set(evaluation.prerequisiteArtifactHashes.map((item) => item.gate)).size !== GATES.length) throw new Error("V9 evaluation prerequisite hashes are invalid");
}

async function listEvaluationAttempts(stateRoot: string, snapshot: Pick<V9StateSnapshot, "manifest" | "manifestSha256" | "pinsSha256" | "pinReceiptSha256">): Promise<V9EvaluationAttempt[]> {
  await assertNoSymlinkComponents(evaluationsPath(stateRoot));
  const allEntries = await readdir(evaluationsPath(stateRoot), { withFileTypes: true });
  if (allEntries.some((entry) => entry.isSymbolicLink())) throw new Error("V9 evaluation directory contains a symbolic link");
  await retainedAtomicTailCount(evaluationsPath(stateRoot), MAX_MANIFEST_BYTES, "V9 evaluation journal");
  const entries = allEntries.filter((entry) => !entry.name.startsWith(".partial-"));
  if (entries.length > 64) throw new Error("V9 evaluation-attempt count exceeds its bound");
  const attempts: V9EvaluationAttempt[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^evaluation-\d{17}-[a-f0-9]{16}\.json$/.test(entry.name)) throw new Error("V9 evaluation directory contains an unsupported entry");
    const evaluation = await readBoundedJson<V9PilotEvaluation>(path.join(evaluationsPath(stateRoot), entry.name), MAX_MANIFEST_BYTES, "V9 evaluation attempt");
    assertEvaluationSchema(evaluation);
    const sha256 = hashV9Record(evaluation);
    if (evaluation.pilotId !== snapshot.manifest.pilotId || evaluation.manifestSha256 !== snapshot.manifestSha256 || evaluation.pinsSha256 !== snapshot.pinsSha256 || evaluation.pinReceiptSha256 !== snapshot.pinReceiptSha256 || !validTimestamp(evaluation.generatedAt) || !validHash(evaluation.journalHeadSha256) || (evaluation.previousEvaluationSha256 !== null && !validHash(evaluation.previousEvaluationSha256)) || evaluation.previousEvaluationSha256 !== (attempts.at(-1)?.sha256 ?? null) || canonicalV9(evaluation.prerequisiteArtifactHashes) !== canonicalV9(snapshot.manifest.prerequisites.map(({ gate, artifactSha256 }) => ({ gate, sha256: artifactSha256 }))) || !entry.name.endsWith(`-${sha256.slice(0, 16)}.json`)) throw new Error("V9 evaluation-attempt chain is invalid");
    if (attempts.length && Date.parse(evaluation.generatedAt) <= Date.parse(attempts.at(-1)!.evaluation.generatedAt)) throw new Error("V9 evaluation-attempt time regressed");
    attempts.push({ evaluation, fileName: entry.name, sha256 });
  }
  return attempts;
}

function unsignedApproval(approval: V9Approval): V9ApprovalUnsigned {
  const { signature: _signature, ...unsigned } = approval;
  return unsigned;
}

function assertApproval(approval: V9Approval, evaluation: V9PilotEvaluation, snapshot: V9StateSnapshot, nowMs: number): void {
  if (!isPlainRecord(approval) || approval.schemaVersion !== 1 || approval.recordType !== "rf-monitor-v9-external-witness-approval" || approval.pilotId !== snapshot.manifest.pilotId || approval.manifestSha256 !== snapshot.manifestSha256 || approval.pinsSha256 !== snapshot.pinsSha256 || approval.pinReceiptSha256 !== snapshot.pinReceiptSha256 || approval.journalHeadSha256 !== snapshot.journalHeadSha256 || approval.evaluationSha256 !== hashV9Record(evaluation) || approval.decision !== "approved" || approval.witnessKeyId !== snapshot.manifest.approvalWitness.keyId || approval.witnessIdentityHash !== snapshot.manifest.approvalWitness.identityHash) throw new Error("V9 approval binding is invalid or stale");
  if (!exactKeys(approval, ["schemaVersion", "recordType", "pilotId", "manifestSha256", "pinsSha256", "pinReceiptSha256", "journalHeadSha256", "evaluationSha256", "approvedAt", "decision", "witnessKeyId", "witnessIdentityHash", "approvers", "attestations", "signature"])) throw new Error("V9 approval contains unsupported fields");
  if (!validTimestamp(approval.approvedAt) || Date.parse(approval.approvedAt) < Date.parse(evaluation.generatedAt) || Date.parse(approval.approvedAt) > nowMs) throw new Error("V9 approval chronology is invalid");
  if (!isPlainRecord(approval.attestations) || !exactKeys(approval.attestations, ["independentWitness", "reviewedArtifactHashes", "noDeveloperAssistanceInScoredDrills", "noQualificationDataWasShortenedOrAccelerated", "limitationsAccepted"]) || !Object.values(approval.attestations).every((value) => value === true)) throw new Error("V9 approval attestations are incomplete");
  const roles = ["release-owner", "verifier-rf-engineer", "operator-representative", "site-owner"] as const;
  if (!Array.isArray(approval.approvers) || approval.approvers.length !== roles.length || new Set(approval.approvers.map((item) => item.role)).size !== roles.length || roles.some((role) => !approval.approvers.some((item) => item.role === role))) throw new Error("V9 approval roles are incomplete");
  if (new Set(approval.approvers.map((item) => item.identityHash)).size < 2 || !approval.approvers.some((item) => item.identityHash === approval.witnessIdentityHash) || approval.approvers.some((item) => !isPlainRecord(item) || !exactKeys(item, ["role", "identityHash", "approvedAt"]) || !validHash(item.identityHash) || !validTimestamp(item.approvedAt) || Date.parse(item.approvedAt) < Date.parse(evaluation.generatedAt) || Date.parse(item.approvedAt) > Date.parse(approval.approvedAt))) throw new Error("V9 approvals require valid independent identities and chronology");
  if (approval.witnessIdentityHash === snapshot.manifest.implementerIdentityHash) throw new Error("V9 witness is not independent of the implementer");
  if (!isPlainRecord(approval.signature) || !exactKeys(approval.signature, ["algorithm", "valueBase64"]) || approval.signature.algorithm !== "Ed25519") throw new Error("V9 approval signature schema is invalid");
  verifyDetachedSignature(unsignedApproval(approval), approval.signature.valueBase64, snapshot.manifest.approvalWitness.publicKeyPem, "V9 external approval");
}

function buildFinalReport(snapshot: V9StateSnapshot, attempt: V9EvaluationAttempt, approval: V9Approval, finalizedAt: string): V9PilotFinalReport {
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-controlled-pilot-final-report",
    frameworkVersion: V9_PILOT_FRAMEWORK_VERSION,
    finalizedAt,
    pilotId: snapshot.manifest.pilotId,
    manifestSha256: snapshot.manifestSha256,
    pinsSha256: snapshot.pinsSha256,
    pinReceiptSha256: snapshot.pinReceiptSha256,
    journalHeadSha256: snapshot.journalHeadSha256!,
    evaluationSha256: hashV9Record(attempt.evaluation),
    evaluationFile: `evaluations/${attempt.fileName}`,
    approvalSha256: hashV9Record(approval),
    gateDecision: "passed",
    productionReady: false,
    nextStep: "install-separate-production-qualification-approval",
  };
}

function assertFinalReportSchema(report: V9PilotFinalReport): void {
  if (!isPlainRecord(report) || !exactKeys(report, ["schemaVersion", "recordType", "frameworkVersion", "finalizedAt", "pilotId", "manifestSha256", "pinsSha256", "pinReceiptSha256", "journalHeadSha256", "evaluationSha256", "evaluationFile", "approvalSha256", "gateDecision", "productionReady", "nextStep"]) || report.schemaVersion !== 1 || report.recordType !== "rf-monitor-v9-controlled-pilot-final-report" || report.frameworkVersion !== V9_PILOT_FRAMEWORK_VERSION || !validTimestamp(report.finalizedAt) || !validSafeId(report.pilotId) || !validHash(report.manifestSha256) || !validHash(report.pinsSha256) || !validHash(report.pinReceiptSha256) || !validHash(report.journalHeadSha256) || !validHash(report.evaluationSha256) || !/^evaluations\/evaluation-\d{17}-[a-f0-9]{16}\.json$/.test(report.evaluationFile) || !validHash(report.approvalSha256) || report.gateDecision !== "passed" || report.productionReady !== false || report.nextStep !== "install-separate-production-qualification-approval") throw new Error("V9 final report schema is invalid");
}

function assertFinalCommitSchema(commit: V9FinalCommit): void {
  if (!isPlainRecord(commit) || !exactKeys(commit, ["schemaVersion", "recordType", "pilotId", "committedAt", "reportSha256", "approvalSha256", "checksumsSha256"]) || commit.schemaVersion !== 1 || commit.recordType !== "rf-monitor-v9-final-commit" || !validSafeId(commit.pilotId) || !validTimestamp(commit.committedAt) || !validHash(commit.reportSha256) || !validHash(commit.approvalSha256) || !validHash(commit.checksumsSha256)) throw new Error("V9 final commit schema is invalid");
}

async function buildFinalChecksumManifest(stateRoot: string, snapshot: V9StateSnapshot, attempts: V9EvaluationAttempt[]): Promise<{ contents: string; fileCount: number }> {
  const lines: string[] = [];
  const add = async (absolutePath: string, relativePath: string, maximumBytes: number, label: string) => {
    const artifact = await hashBoundedArtifact(absolutePath, maximumBytes, label);
    lines.push(`${artifact.sha256}  ${relativePath}`);
  };
  await add(manifestPath(stateRoot), "manifest.json", MAX_MANIFEST_BYTES, "V9 manifest");
  await add(pinsPath(stateRoot), "pins.json", MAX_MANIFEST_BYTES, "V9 pins");
  await add(pinReceiptPath(stateRoot), "pin-receipt.json", MAX_MANIFEST_BYTES, "V9 pin receipt");
  for (const entry of snapshot.entries) {
    const fileName = dayFileName(entry.sequence);
    await add(path.join(daysPath(stateRoot), fileName), `days/${fileName}`, MAX_SUMMARY_BYTES, `V9 ${fileName}`);
  }
  for (const attempt of attempts) await add(path.join(evaluationsPath(stateRoot), attempt.fileName), `evaluations/${attempt.fileName}`, MAX_MANIFEST_BYTES, "V9 evaluation attempt");
  await add(path.join(stateRoot, "approval.json"), "approval.json", MAX_MANIFEST_BYTES, "V9 approval");
  await add(finalReportPath(stateRoot), "final-report.json", MAX_MANIFEST_BYTES, "V9 final report");
  return { contents: `${lines.join("\n")}\n`, fileCount: lines.length };
}

async function finalizeV9PilotUnlocked(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, approval: V9Approval, nowMs: number): Promise<V9PilotFinalReport> {
  const snapshot = await loadV9PilotState(stateRoot, nowMs);
  assertExternalTrustAnchors(snapshot, anchors);
  if (!validHash(approval.evaluationSha256)) throw new Error("V9 approval evaluation digest is invalid");
  const attempts = await listEvaluationAttempts(stateRoot, snapshot);
  const attempt = attempts.find((candidate) => candidate.sha256 === approval.evaluationSha256);
  if (!attempt) throw new Error("V9 approval references an unavailable evaluation attempt");
  if (attempt !== attempts.at(-1)) throw new Error("V9 approval must bind the latest immutable evaluation attempt");
  const persistedEvaluation = attempt.evaluation;
  await verifyPilotEvidence(evidenceRoot, snapshot);
  const currentEvaluation = computeEvaluation(snapshot, persistedEvaluation.generatedAt, persistedEvaluation.previousEvaluationSha256);
  if (canonicalV9(currentEvaluation) !== canonicalV9(persistedEvaluation)) throw new Error("V9 evaluation is stale or does not match the recovered journal");
  if (persistedEvaluation.decision !== "eligible-for-witness-review" || persistedEvaluation.blockers.length) throw new Error("V9 failed evaluation cannot be approved");
  assertApproval(approval, persistedEvaluation, snapshot, nowMs);
  const existingReport = await readOptionalBoundedJson<V9PilotFinalReport>(finalReportPath(stateRoot), MAX_MANIFEST_BYTES, "V9 final report");
  if (existingReport) assertFinalReportSchema(existingReport);
  const finalizedAt = existingReport?.finalizedAt ?? new Date(nowMs).toISOString();
  if (Date.parse(finalizedAt) < Date.parse(approval.approvedAt) || Date.parse(finalizedAt) > nowMs) throw new Error("V9 finalization time is invalid");
  const report = buildFinalReport(snapshot, attempt, approval, finalizedAt);
  await writeExclusiveOrVerify(path.join(stateRoot, "approval.json"), `${canonicalV9(approval)}\n`, "V9 approval");
  await writeExclusiveOrVerify(finalReportPath(stateRoot), `${canonicalV9(report)}\n`, "V9 final report");
  const { contents: checksumsContents } = await buildFinalChecksumManifest(stateRoot, snapshot, attempts);
  await writeExclusiveOrVerify(path.join(stateRoot, "SHA256SUMS"), checksumsContents, "V9 checksum manifest");
  const existingCommit = await readOptionalBoundedJson<V9FinalCommit>(finalCommitPath(stateRoot), MAX_MANIFEST_BYTES, "V9 final commit");
  if (existingCommit) assertFinalCommitSchema(existingCommit);
  const committedAt = existingCommit?.committedAt ?? new Date(nowMs).toISOString();
  if (Date.parse(committedAt) < Date.parse(finalizedAt) || Date.parse(committedAt) > nowMs) throw new Error("V9 final commit time is invalid");
  const finalCommit: V9FinalCommit = {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-final-commit",
    pilotId: snapshot.manifest.pilotId,
    committedAt,
    reportSha256: sha256V9(`${canonicalV9(report)}\n`),
    approvalSha256: sha256V9(`${canonicalV9(approval)}\n`),
    checksumsSha256: sha256V9(checksumsContents),
  };
  await writeExclusiveOrVerify(finalCommitPath(stateRoot), `${canonicalV9(finalCommit)}\n`, "V9 final commit");
  return report;
}

export async function finalizeV9Pilot(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, approval: V9Approval, nowMs = Date.now()): Promise<V9PilotFinalReport> {
  return withV9OperationLock(stateRoot, "finalize", () => finalizeV9PilotUnlocked(stateRoot, evidenceRoot, anchors, approval, nowMs));
}

async function assertExactFinalBundleFileSet(stateRoot: string, snapshot: V9StateSnapshot, attempts: V9EvaluationAttempt[]): Promise<void> {
  const rootEntries = await readdir(stateRoot, { withFileTypes: true });
  const expectedRoot = new Map<string, "file" | "directory">([
    ["manifest.json", "file"],
    ["pins.json", "file"],
    ["pin-receipt.json", "file"],
    ["approval.json", "file"],
    ["final-report.json", "file"],
    ["SHA256SUMS", "file"],
    ["final-commit.json", "file"],
    ["days", "directory"],
    ["evaluations", "directory"],
  ]);
  if (rootEntries.length !== expectedRoot.size) throw new Error("V9 final bundle root file set is not exact");
  for (const entry of rootEntries) {
    const expected = expectedRoot.get(entry.name);
    if (!expected || entry.isSymbolicLink() || (expected === "file" ? !entry.isFile() : !entry.isDirectory())) throw new Error("V9 final bundle contains an unsupported or unsafe root entry");
  }
  const dayEntries = await readdir(daysPath(stateRoot), { withFileTypes: true });
  const expectedDays = new Set(snapshot.entries.map((entry) => dayFileName(entry.sequence)));
  if (dayEntries.length !== expectedDays.size || dayEntries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !expectedDays.has(entry.name))) throw new Error("V9 final bundle daily file set is not exact");
  const evaluationEntries = await readdir(evaluationsPath(stateRoot), { withFileTypes: true });
  const expectedEvaluations = new Set(attempts.map((attempt) => attempt.fileName));
  if (evaluationEntries.length !== expectedEvaluations.size || evaluationEntries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !expectedEvaluations.has(entry.name))) throw new Error("V9 final bundle evaluation file set is not exact");
}

function verifyDeterministicEvaluationHistory(snapshot: V9StateSnapshot, attempts: V9EvaluationAttempt[], nowMs: number): void {
  const journalIndex = new Map(snapshot.entries.map((entry, index) => [hashV9Record(entry), index]));
  for (const attempt of attempts) {
    const index = journalIndex.get(attempt.evaluation.journalHeadSha256);
    if (index === undefined) throw new Error("V9 evaluation does not bind an exact journal prefix");
    const entries = snapshot.entries.slice(0, index + 1);
    const periodEndedAt = entries.at(-1)!.summary.periodEndedAt;
    if (Date.parse(attempt.evaluation.generatedAt) < Date.parse(periodEndedAt) || Date.parse(attempt.evaluation.generatedAt) > nowMs) throw new Error("V9 evaluation chronology is invalid");
    const historicalSnapshot: V9StateSnapshot = {
      ...snapshot,
      entries,
      journalHeadSha256: attempt.evaluation.journalHeadSha256,
      recoveredAtomicTailCount: 0,
    };
    const deterministic = computeEvaluation(historicalSnapshot, attempt.evaluation.generatedAt, attempt.evaluation.previousEvaluationSha256);
    if (canonicalV9(deterministic) !== canonicalV9(attempt.evaluation)) throw new Error("V9 evaluation history is not deterministic from its journal prefix");
  }
}

export async function verifyV9FinalBundle(stateRoot: string, evidenceRoot: string, anchors: V9TrustAnchors, nowMs = Date.now()): Promise<V9VerifiedFinalBundle> {
  const snapshot = await verifyV9PilotEvidenceStatus(stateRoot, evidenceRoot, anchors, nowMs);
  if (snapshot.recoveredAtomicTailCount !== 0 || !snapshot.journalHeadSha256) throw new Error("V9 final bundle contains retained tails or an empty journal");
  const attempts = await listEvaluationAttempts(stateRoot, snapshot);
  if (!attempts.length) throw new Error("V9 final bundle has no evaluation attempt");
  await assertExactFinalBundleFileSet(stateRoot, snapshot, attempts);
  verifyDeterministicEvaluationHistory(snapshot, attempts, nowMs);
  const latest = attempts.at(-1)!;
  if (latest.evaluation.decision !== "eligible-for-witness-review" || latest.evaluation.blockers.length) throw new Error("V9 final bundle does not end in an eligible evaluation");
  const approval = await readBoundedJson<V9Approval>(path.join(stateRoot, "approval.json"), MAX_MANIFEST_BYTES, "V9 approval");
  assertApproval(approval, latest.evaluation, snapshot, nowMs);
  const report = await readBoundedJson<V9PilotFinalReport>(finalReportPath(stateRoot), MAX_MANIFEST_BYTES, "V9 final report");
  assertFinalReportSchema(report);
  if (Date.parse(report.finalizedAt) < Date.parse(approval.approvedAt) || Date.parse(report.finalizedAt) > nowMs) throw new Error("V9 final report chronology is invalid");
  const deterministicReport = buildFinalReport(snapshot, latest, approval, report.finalizedAt);
  if (canonicalV9(deterministicReport) !== canonicalV9(report)) throw new Error("V9 final report is not deterministic from the approved evaluation");
  const { contents: expectedChecksums, fileCount } = await buildFinalChecksumManifest(stateRoot, snapshot, attempts);
  const storedChecksums = await readBoundedFile(path.join(stateRoot, "SHA256SUMS"), 128 * 1024, "V9 checksum manifest");
  if (!storedChecksums.equals(Buffer.from(expectedChecksums))) throw new Error("V9 checksum manifest is missing, extra, reordered, or does not match the exact bundle");
  const commit = await readBoundedJson<V9FinalCommit>(finalCommitPath(stateRoot), MAX_MANIFEST_BYTES, "V9 final commit");
  assertFinalCommitSchema(commit);
  if (commit.pilotId !== snapshot.manifest.pilotId || Date.parse(commit.committedAt) < Date.parse(report.finalizedAt) || Date.parse(commit.committedAt) > nowMs) throw new Error("V9 final commit binding or chronology is invalid");
  const expectedCommit: V9FinalCommit = {
    schemaVersion: 1,
    recordType: "rf-monitor-v9-final-commit",
    pilotId: snapshot.manifest.pilotId,
    committedAt: commit.committedAt,
    reportSha256: sha256V9(`${canonicalV9(report)}\n`),
    approvalSha256: sha256V9(`${canonicalV9(approval)}\n`),
    checksumsSha256: sha256V9(expectedChecksums),
  };
  if (canonicalV9(expectedCommit) !== canonicalV9(commit)) throw new Error("V9 final commit does not bind the verified approval, report, and checksum manifest");
  return {
    verification: "verified-passed",
    verifiedAt: new Date(nowMs).toISOString(),
    report,
    commit,
    commitSha256: hashV9Record(commit),
    verifiedFileCount: fileCount + 2,
  };
}
