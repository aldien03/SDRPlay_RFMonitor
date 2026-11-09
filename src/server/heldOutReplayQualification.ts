import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  alertingSettingsHash,
  baselineFingerprintId,
  centralAnalysisBinBounds,
  DetectionEngine,
  detectionRuleFingerprint,
  type DetectionThresholds,
} from "../shared/detection";
import { detectorQualificationPlan } from "../shared/detectorQualification";
import {
  MAX_ANALYSIS_SPAN_HZ,
  parseSupportedReceiverModel,
  PRODUCTION_SAMPLE_RATE_HZ,
  type SupportedReceiverModel,
} from "../shared/productContract";
import type {
  BandCatalog,
  BandPreset,
  BaselineDescriptor,
  BaselineFingerprint,
  DetectionKind,
  OperationalSettings,
  PhysicalCaptureTarget,
  TargetObservation,
  TargetVisitUnknownReason,
} from "../shared/types";
import type { BinomialConfidenceInterval } from "../shared/syntheticValidation";
import { binomialWilsonOneSidedInterval } from "./syntheticValidation";
import type { FrozenCandidateIdentity, ProtectedTreeSnapshot } from "./syntheticQualificationCampaign";

export const V5_REPLAY_SCHEMA_VERSION = 1 as const;
export const V5_REPLAY_FRAMEWORK_VERSION = "rf-v5-held-out-replay-1.1.0" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PRECOMMITMENT_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const MAX_TRUTH_BYTES = 256 * 1024;
const MAX_OBSERVATION_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVATION_LINE_BYTES = 64 * 1024;
const MAX_FFT_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_CORPUS_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_CORPUS_FILES = 50_000;
const MAX_SESSIONS = 10_000;
const MAX_OBSERVATIONS_PER_SESSION = 100_000;
const MAX_INPUT_BINS = 65_536;
const MAX_ANALYSIS_BINS = 16_384;
const MAX_WITNESS_KEY_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROTECTED_TREE_ENTRIES = 100_000;
const MAX_PROTECTED_TREE_BYTES = 512 * 1024 * 1024;
const CONFIDENCE = 0.95;

export const V5_REPLAY_FAMILIES = [
  "wideband",
  "pulsed-wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
  "data-gap",
  "configuration-change",
  "matched-power-spoofing",
  "replay-nuisance",
] as const;

export type V5ReplayFamily = typeof V5_REPLAY_FAMILIES[number];
export type V5ExpectedOutcome = "alert" | "no-alert" | "unknown";
export type V5SessionVerdict =
  | "detected"
  | "missed"
  | "alert-free"
  | "false-alert"
  | "unknown-observed"
  | "unknown-not-observed"
  | "unknown"
  | "unobserved"
  | "unexpected-alert";

export interface V5CorpusFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface V5ReplayCriterion {
  criterionId: string;
  targetId: string;
  family: V5ReplayFamily;
  expectedOutcome: V5ExpectedOutcome;
  sessionIds: string[];
  minimumIndependentSessions: number;
  requiredWilsonLowerBound: number | null;
  maximumUnknownFraction: number;
  maximumUnobservedFraction: number;
  testedEnvelope: {
    envelopeId: string;
    description: string;
    parameters: Record<string, string | number | boolean>;
  };
}

export interface V5ReplayFrozenIdentity {
  release: FrozenCandidateIdentity;
  configurationHash: string;
  catalogVersion: string;
  catalogHash: string;
  detectorVersion: string;
  detectorRuleSetId: string;
  detectorRuleHash: string;
  detectorThresholds: DetectionThresholds;
  /** Hash of every resolved alert policy frozen with the corpus (alert sensitivity). */
  alertingHash?: string;
  targetIds: string[];
  families: V5ReplayFamily[];
}

export interface V5ReplayCorpusSessionEntry {
  sessionId: string;
  criterionId: string;
  descriptorPath: string;
  descriptorSha256: string;
  truthCommitment: string;
}

export interface V5ReplayPrecommitment {
  schemaVersion: 1;
  recordType: "rf-monitor-v5-held-out-precommitment";
  corpusId: string;
  committedAt: string;
  frozen: V5ReplayFrozenIdentity;
  criteria: V5ReplayCriterion[];
  sessions: V5ReplayCorpusSessionEntry[];
  custody: {
    acquisitionCustodianIdHash: string;
    truthLabelerIdHash: string;
    detectorCustodianIdHash: string;
  };
  nonce: string;
}

export interface V5ReplayCorpusManifest {
  schemaVersion: typeof V5_REPLAY_SCHEMA_VERSION;
  recordType: "rf-monitor-v5-held-out-fft-corpus";
  frameworkVersion: typeof V5_REPLAY_FRAMEWORK_VERSION;
  corpusId: string;
  corpusPurpose: "external-held-out-qualification";
  acquisitionDataDomain: "field";
  replayDataDomain: "test";
  createdAt: string;
  custody: {
    acquisitionClosedAt: string;
    detectorFrozenAt: string;
    criteriaCommittedAt: string;
    truthCommittedAt: string;
    unblindedAt: string;
    corpusSealedAt: string;
    acquisitionCustodianIdHash: string;
    truthLabelerIdHash: string;
    detectorCustodianIdHash: string;
    independentTruthLabels: true;
    holdoutNotUsedForTuning: true;
    thresholdsFrozenBeforeUnblinding: true;
  };
  frozen: V5ReplayFrozenIdentity;
  criteria: V5ReplayCriterion[];
  sessions: V5ReplayCorpusSessionEntry[];
  precommitment: { path: string; sha256: string };
  externalWitness: {
    receiptId: string;
    keySha256: string;
    signedAt: string;
    unblindingNotBefore: string;
    statementSha256: string;
    signatureAlgorithm: "ed25519";
    signatureBase64: string;
  };
  files: V5CorpusFileEntry[];
  corpusTreeSha256: string;
}

export interface V5SessionDescriptor {
  schemaVersion: 1;
  recordType: "rf-monitor-v5-held-out-fft-session";
  sessionId: string;
  acquisitionId: string;
  criterionId: string;
  independentSession: true;
  source: {
    kind: "real-receiver-normalized-fft";
    acquisitionDataDomain: "field";
    normalizedEncoding: "uint8";
    realReceiver: true;
    synthetic: false;
    simulation: false;
    replay: false;
    iq: false;
  };
  receiver: {
    model: "RSPdx" | "RSPdx R2";
    serialSha256: string;
  };
  sdrconnect: {
    version: string;
    sampleRateReadBackConfirmed: true;
    fftValues: "normalized-uint8-display-values";
  };
  target: {
    id: string;
    label: string;
    bandId: string;
    affectedBandIds: string[];
    centerHz: number;
    captureSpanHz: number;
    analysisSpanHz: number;
  };
  grid: {
    sampleRateHz: 10_000_000;
    inputBinCount: number;
    analysisStartBin: number;
    analysisEndBin: number;
    analysisMaskHash: string;
    spectrumReference: number;
    spectrumBase: number;
  };
  fingerprint: BaselineFingerprint;
  fingerprintId: string;
  baseline: {
    descriptor: BaselineDescriptor;
    mediansPath: string;
    madsPath: string;
  };
  observations: {
    indexPath: string;
    fftPath: string;
    recordCount: number;
    validRecordCount: number;
    unknownRecordCount: number;
  };
  truth: {
    disclosurePath: string;
    commitment: string;
    commitmentAlgorithm: "sha256-canonical-json";
  };
}

export interface V5TruthDisclosure {
  schemaVersion: 1;
  recordType: "rf-monitor-v5-held-out-truth";
  sessionId: string;
  criterionId: string;
  targetId: string;
  family: V5ReplayFamily;
  expectedOutcome: V5ExpectedOutcome;
  eventWindow: {
    startMonotonicMs: number;
    endMonotonicMs: number;
    alertGraceMs: number;
  };
  envelopeId: string;
  withinPredeclaredEnvelope: true;
  measuredParameters: Record<string, string | number | boolean>;
  truthLabelerIdHash: string;
  committedAt: string;
  nonce: string;
}

export interface V5ValidObservationRecord {
  schemaVersion: 1;
  sequence: number;
  outcome: "valid";
  visitId: string;
  observedAt: string;
  firstMonotonicMs: number;
  lastMonotonicMs: number;
  exposureMs: number;
  acceptedFrameCount: number;
  intentionalDiscardedFrames: number;
  rawOffset: number;
  rawLength: number;
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  confirmedCenterHz: number;
  confirmedSampleRateHz: number;
  tuneConfirmedAt: string;
  overload: boolean;
  healthComplete: true;
}

export interface V5UnknownObservationRecord {
  schemaVersion: 1;
  sequence: number;
  outcome: "unknown";
  observedAt: string;
  startMonotonicMs: number;
  endMonotonicMs: number;
  reason: TargetVisitUnknownReason;
  intentionalDiscardedFrames: number;
}

export type V5ObservationRecord = V5ValidObservationRecord | V5UnknownObservationRecord;

export interface V5CandidateContext {
  release: FrozenCandidateIdentity;
  catalog: BandCatalog;
  operationalSettings: OperationalSettings;
  configurationHash: string;
  catalogHash: string;
  detectorRuleHash: string;
}

export interface V5WitnessContext {
  /** Separately supplied pinned Ed25519 public key; never loaded from the corpus. */
  publicKeyPem: string | Uint8Array;
  /** Out-of-band approved SHA-256 of the public SPKI DER. */
  expectedKeySha256: string;
}

export interface V5WitnessStatement {
  schemaVersion: 1;
  purpose: "rf-monitor-v5-held-out-precommitment-witness";
  corpusId: string;
  precommitmentSha256: string;
  precommitmentCommittedAt: string;
  signedAt: string;
  unblindingNotBefore: string;
}

export interface V5CorpusValidation {
  root: string;
  manifest: V5ReplayCorpusManifest;
  manifestSha256: string;
  corpusTreeSha256: string;
  precommitmentSha256: string;
  fileCount: number;
  totalBytes: number;
}

export interface V5SessionScore {
  sessionId: string;
  criterionId: string;
  targetId: string;
  family: V5ReplayFamily;
  expectedOutcome: V5ExpectedOutcome;
  verdict: V5SessionVerdict;
  truthCommitment: string;
  truthVerified: boolean;
  validObservations: number;
  unknownObservations: number;
  observedEventExposureMs: number;
  detected: boolean;
  alertFree: boolean;
  unknown: boolean;
  unobserved: boolean;
  alertKinds: DetectionKind[];
  unexpectedAlerts: number;
  latency?: {
    wallClockMs: number;
    observedExposureMs: number;
    unobservedMs: number;
  };
}

export interface V5CriterionScore {
  criterionId: string;
  targetId: string;
  family: V5ReplayFamily;
  expectedOutcome: V5ExpectedOutcome;
  sessions: number;
  evaluableSessions: number;
  successes: number;
  failures: number;
  detections: number;
  misses: number;
  alertFree: number;
  falseAlerts: number;
  unknown: number;
  unobserved: number;
  interval: BinomialConfidenceInterval | null;
  requiredWilsonLowerBound: number | null;
  minimumIndependentSessions: number;
  maximumUnknownFraction: number;
  maximumUnobservedFraction: number;
  passed: boolean;
  failureReasons: string[];
}

export interface V5ReplayReport {
  schemaVersion: typeof V5_REPLAY_SCHEMA_VERSION;
  recordType: "rf-monitor-v5-held-out-replay-result";
  frameworkVersion: typeof V5_REPLAY_FRAMEWORK_VERSION;
  gate: "V5";
  generatedAt: string;
  runId: string;
  release: FrozenCandidateIdentity;
  corpus: {
    corpusId: string;
    manifestSha256: string;
    treeSha256: string;
    precommitmentSha256: string;
    files: number;
    bytes: number;
  };
  protocol: {
    input: "real normalized uint8 FFT";
    scoringUnit: "independent-session";
    confidence: 0.95;
    confidenceMethod: "one-sided-wilson";
    detectorTraining: "frozen";
    thresholdMutationAllowed: false;
    replayDataDomain: "test";
  };
  externalWitness: {
    receiptId: string;
    keySha256: string;
    precommitmentCommittedAt: string;
    signedAt: string;
    unblindingNotBefore: string;
    statementSha256: string;
    signatureAlgorithm: "ed25519";
    signatureBase64: string;
    signatureVerified: true;
  };
  isolation: { before: ProtectedTreeSnapshot; after: ProtectedTreeSnapshot; unchanged: boolean };
  sessions: V5SessionScore[];
  criteria: V5CriterionScore[];
  byTargetFamily: V5CriterionScore[];
  counts: {
    sessions: number;
    detected: number;
    missed: number;
    alertFree: number;
    falseAlerts: number;
    unknown: number;
    unobserved: number;
  };
  result: {
    gateDecision: "passed" | "failed";
    allCriteriaPassed: boolean;
    corpusUnchanged: boolean;
    fieldTreeUnchanged: boolean;
    thresholdMutationDetected: false;
    productionReady: false;
  };
  deterministicResultHash: string;
  limitations: string[];
}

export interface V5ReplayOptions {
  corpusRoot: string;
  protectedFieldRoot: string;
  candidate: V5CandidateContext;
  witness: V5WitnessContext;
  now?: () => Date;
  runId?: string;
}

interface LoadedSession {
  entry: V5ReplayCorpusSessionEntry;
  manifest: V5ReplayCorpusManifest;
  descriptor: V5SessionDescriptor;
  truth: V5TruthDisclosure;
  observations: V5ObservationRecord[];
}

const UNKNOWN_REASONS = new Set<TargetVisitUnknownReason>([
  "tune-timeout",
  "tune-mismatch",
  "insufficient-frames",
  "bin-grid-changed",
  "receiver-unhealthy",
  "configuration-changed",
]);

const ALERT_FAMILIES = new Set<V5ReplayFamily>([
  "wideband",
  "pulsed-wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
]);
const NO_ALERT_FAMILIES = new Set<V5ReplayFamily>(["matched-power-spoofing", "replay-nuisance"]);
const UNKNOWN_FAMILIES = new Set<V5ReplayFamily>(["data-gap", "configuration-change"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

export function sha256CanonicalV5(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function createV5WitnessStatement(input: {
  corpusId: string;
  precommitmentSha256: string;
  precommitmentCommittedAt: string;
  signedAt: string;
  unblindingNotBefore: string;
}): V5WitnessStatement {
  return {
    schemaVersion: 1,
    purpose: "rf-monitor-v5-held-out-precommitment-witness",
    ...input,
  };
}

export function v5WitnessMessage(statement: V5WitnessStatement): Buffer {
  return Buffer.from(JSON.stringify(canonical(statement)), "utf8");
}

function witnessPublicKey(context: V5WitnessContext): { key: KeyObject; keySha256: string } {
  const bytes = typeof context.publicKeyPem === "string" ? Buffer.from(context.publicKeyPem, "utf8") : Buffer.from(context.publicKeyPem);
  if (!bytes.byteLength || bytes.byteLength > MAX_WITNESS_KEY_BYTES) throw new Error("V5 witness public key exceeds its byte bound");
  assertSha256(context.expectedKeySha256, "expected V5 witness key fingerprint");
  let key: KeyObject;
  try { key = createPublicKey(bytes); } catch { throw new Error("V5 witness public key is invalid"); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("V5 witness key must be an Ed25519 public key");
  const der = key.export({ type: "spki", format: "der" });
  const keySha256 = sha256Bytes(der);
  if (keySha256 !== context.expectedKeySha256) throw new Error("V5 witness public key does not match the out-of-band pinned fingerprint");
  return { key, keySha256 };
}

export function v5WitnessKeyFingerprint(publicKeyPem: string | Uint8Array): string {
  const bytes = typeof publicKeyPem === "string" ? Buffer.from(publicKeyPem, "utf8") : Buffer.from(publicKeyPem);
  if (!bytes.byteLength || bytes.byteLength > MAX_WITNESS_KEY_BYTES) throw new Error("V5 witness public key exceeds its byte bound");
  const key = createPublicKey(bytes);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("V5 witness key must be an Ed25519 public key");
  return sha256Bytes(key.export({ type: "spki", format: "der" }));
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function assertSafeId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
}

function assertFinite(value: unknown, name: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is outside its bound`);
}

function assertInteger(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} is outside its integer bound`);
}

function assertIso(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
}

function safeRelativePath(relativePath: unknown, name: string): string {
  if (typeof relativePath !== "string"
    || !relativePath
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${name} is not a safe relative path`);
  }
  return relativePath;
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Corpus path escapes root: ${relativePath}`);
  return resolved;
}

async function canonicalDirectory(directoryPath: string, name: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${name} must be a real directory, not a symlink`);
  const canonicalPath = await realpath(resolved);
  if (canonicalPath !== resolved) throw new Error(`${name} may not contain symlinked path components`);
  return canonicalPath;
}

/** Resolve a possibly absent directory without allowing any existing symlinked parent. */
async function canonicalPotentialDirectory(directoryPath: string, name: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const details = await lstat(cursor);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${name} existing ancestor must be a real directory`);
      const canonicalAncestor = await realpath(cursor);
      if (canonicalAncestor !== cursor) throw new Error(`${name} may not contain symlinked path components`);
      return path.join(canonicalAncestor, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`${name} has no existing safe ancestor`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function openRegularNoFollow(filePath: string, maximumBytes: number, allowEmpty = false): Promise<{ handle: FileHandle; bytes: number }> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || (!allowEmpty && details.size <= 0) || details.size > maximumBytes) {
      throw new Error(`File size/type bound failed: ${path.basename(filePath)}`);
    }
    return { handle, bytes: details.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBoundedBuffer(filePath: string, maximumBytes: number): Promise<Buffer> {
  const { handle, bytes } = await openRegularNoFollow(filePath, maximumBytes);
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const result = await handle.read(buffer, 0, bytes, 0);
    if (result.bytesRead !== bytes) throw new Error(`Short read: ${path.basename(filePath)}`);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(filePath: string, maximumBytes: number, name: string): Promise<unknown> {
  const bytes = await readBoundedBuffer(filePath, maximumBytes);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function corpusFileEntry(manifest: V5ReplayCorpusManifest, relativePath: string, name: string): V5CorpusFileEntry {
  const entry = manifest.files.find((candidate) => candidate.path === relativePath);
  if (!entry) throw new Error(`${name} is not bound by the V5 corpus manifest`);
  return entry;
}

async function readBoundCorpusBuffer(
  root: string,
  manifest: V5ReplayCorpusManifest,
  relativePath: string,
  maximumBytes: number,
  name: string,
): Promise<Buffer> {
  const entry = corpusFileEntry(manifest, relativePath, name);
  const bytes = await readBoundedBuffer(resolveInside(root, relativePath), Math.min(maximumBytes, entry.bytes));
  if (bytes.byteLength !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) {
    throw new Error(`${name} changed after the V5 corpus was validated`);
  }
  return bytes;
}

async function readBoundCorpusJson(
  root: string,
  manifest: V5ReplayCorpusManifest,
  relativePath: string,
  maximumBytes: number,
  name: string,
): Promise<unknown> {
  const bytes = await readBoundCorpusBuffer(root, manifest, relativePath, maximumBytes, name);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

async function hashRegularFile(filePath: string, maximumBytes: number): Promise<{ sha256: string; bytes: number }> {
  const { handle, bytes } = await openRegularNoFollow(filePath, maximumBytes, true);
  const hash = createHash("sha256");
  try {
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const inverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) || (!inverse.startsWith("..") && !path.isAbsolute(inverse));
}

async function listCorpusFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, child.name);
      const details = await lstat(absolute);
      entries += 1;
      if (entries > MAX_CORPUS_FILES * 2) throw new Error("Corpus tree exceeds its entry-count bound");
      if (details.isSymbolicLink()) throw new Error(`Corpus contains a symbolic link: ${path.relative(root, absolute)}`);
      if (details.isDirectory()) pending.push(absolute);
      else if (details.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"));
      else throw new Error(`Corpus contains a non-regular entry: ${path.relative(root, absolute)}`);
    }
  }
  return result.sort();
}

function validateFrozenIdentity(value: unknown): V5ReplayFrozenIdentity {
  if (!isRecord(value) || !isRecord(value.release) || !isRecord(value.detectorThresholds)) throw new Error("Frozen V5 identity is invalid");
  const release = value.release as unknown as FrozenCandidateIdentity;
  if (release.schemaVersion !== 1 || release.product !== "rf-monitor") throw new Error("Frozen release identity is invalid");
  assertSafeId(release.buildId, "release buildId");
  if (typeof release.releaseVersion !== "string" || !release.releaseVersion.trim()) throw new Error("releaseVersion is invalid");
  assertSha256(release.sourceDigest, "release sourceDigest");
  assertSha256(release.packageDigest, "release packageDigest");
  assertSha256(release.dependencyLockDigest, "release dependencyLockDigest");
  assertSha256(value.configurationHash, "configurationHash");
  assertSha256(value.catalogHash, "catalogHash");
  assertSha256(value.detectorRuleHash, "detectorRuleHash");
  if (typeof value.catalogVersion !== "string" || !value.catalogVersion.trim()
    || typeof value.detectorVersion !== "string" || !value.detectorVersion.trim()
    || value.detectorRuleSetId !== "rf-relative-mad-v1") throw new Error("Frozen detector/catalog identity is invalid");
  if (!Array.isArray(value.targetIds) || !Array.isArray(value.families)) throw new Error("Frozen target/family identity is invalid");
  return value as unknown as V5ReplayFrozenIdentity;
}

function expectedOutcomeForFamily(family: V5ReplayFamily): V5ExpectedOutcome {
  if (ALERT_FAMILIES.has(family)) return "alert";
  if (NO_ALERT_FAMILIES.has(family)) return "no-alert";
  if (UNKNOWN_FAMILIES.has(family)) return "unknown";
  throw new Error(`Unsupported V5 family: ${family}`);
}

function validateCriterion(value: unknown): V5ReplayCriterion {
  if (!isRecord(value) || !isRecord(value.testedEnvelope) || !isRecord(value.testedEnvelope.parameters)) throw new Error("V5 criterion is invalid");
  assertSafeId(value.criterionId, "criterionId");
  assertSafeId(value.targetId, "criterion targetId");
  if (!V5_REPLAY_FAMILIES.includes(value.family as V5ReplayFamily)) throw new Error(`Criterion ${value.criterionId} family is invalid`);
  const expected = expectedOutcomeForFamily(value.family as V5ReplayFamily);
  if (value.expectedOutcome !== expected) throw new Error(`Criterion ${value.criterionId} expected outcome does not match its family`);
  if (!Array.isArray(value.sessionIds) || value.sessionIds.length < 30 || value.sessionIds.length > MAX_SESSIONS) throw new Error(`Criterion ${value.criterionId} needs at least 30 predeclared independent sessions`);
  const ids = new Set<string>();
  for (const sessionId of value.sessionIds) { assertSafeId(sessionId, "criterion sessionId"); if (ids.has(sessionId)) throw new Error(`Criterion ${value.criterionId} repeats a session`); ids.add(sessionId); }
  assertInteger(value.minimumIndependentSessions, "minimumIndependentSessions", 30, value.sessionIds.length);
  if (expected === "unknown") {
    if (value.requiredWilsonLowerBound !== null) throw new Error(`Unknown criterion ${value.criterionId} cannot use a detection/alert-free Wilson threshold`);
  } else {
    assertFinite(value.requiredWilsonLowerBound, "requiredWilsonLowerBound", 0.5, 1);
  }
  assertFinite(value.maximumUnknownFraction, "maximumUnknownFraction", 0, 1);
  assertFinite(value.maximumUnobservedFraction, "maximumUnobservedFraction", 0, 1);
  assertSafeId(value.testedEnvelope.envelopeId, "envelopeId");
  if (typeof value.testedEnvelope.description !== "string" || !value.testedEnvelope.description.trim() || Object.keys(value.testedEnvelope.parameters).length === 0) {
    throw new Error(`Criterion ${value.criterionId} tested envelope is empty`);
  }
  return value as unknown as V5ReplayCriterion;
}

function validateSessionEntry(value: unknown): V5ReplayCorpusSessionEntry {
  if (!isRecord(value)) throw new Error("V5 session entry is invalid");
  assertSafeId(value.sessionId, "sessionId");
  assertSafeId(value.criterionId, "session criterionId");
  safeRelativePath(value.descriptorPath, "session descriptorPath");
  assertSha256(value.descriptorSha256, "session descriptorSha256");
  assertSha256(value.truthCommitment, "session truthCommitment");
  return value as unknown as V5ReplayCorpusSessionEntry;
}

function validateCustody(manifest: Record<string, unknown>): V5ReplayCorpusManifest["custody"] {
  if (!isRecord(manifest.custody)) throw new Error("V5 custody record is invalid");
  const custody = manifest.custody;
  for (const name of ["acquisitionClosedAt", "detectorFrozenAt", "criteriaCommittedAt", "truthCommittedAt", "unblindedAt", "corpusSealedAt"] as const) assertIso(custody[name], name);
  for (const name of ["acquisitionCustodianIdHash", "truthLabelerIdHash", "detectorCustodianIdHash"] as const) assertSha256(custody[name], name);
  if (new Set([custody.acquisitionCustodianIdHash, custody.truthLabelerIdHash, custody.detectorCustodianIdHash]).size !== 3) {
    throw new Error("V5 acquisition, truth, and detector custodian identities must be independently hashed and distinct");
  }
  if (custody.independentTruthLabels !== true || custody.holdoutNotUsedForTuning !== true || custody.thresholdsFrozenBeforeUnblinding !== true) {
    throw new Error("V5 independence and no-holdout-tuning attestations are required");
  }
  const acquisitionClosedAt = Date.parse(custody.acquisitionClosedAt as string);
  const detectorFrozenAt = Date.parse(custody.detectorFrozenAt as string);
  const criteriaCommittedAt = Date.parse(custody.criteriaCommittedAt as string);
  const truthCommittedAt = Date.parse(custody.truthCommittedAt as string);
  const unblindedAt = Date.parse(custody.unblindedAt as string);
  const sealedAt = Date.parse(custody.corpusSealedAt as string);
  if (acquisitionClosedAt > truthCommittedAt || detectorFrozenAt > unblindedAt || criteriaCommittedAt > unblindedAt || truthCommittedAt > unblindedAt || unblindedAt > sealedAt) {
    throw new Error("V5 custody timestamps do not prove acquisition, frozen criteria/rules, truth commitment, unblinding, and sealing order");
  }
  return custody as unknown as V5ReplayCorpusManifest["custody"];
}

function validateCorpusManifest(value: unknown): V5ReplayCorpusManifest {
  if (!isRecord(value)
    || value.schemaVersion !== V5_REPLAY_SCHEMA_VERSION
    || value.recordType !== "rf-monitor-v5-held-out-fft-corpus"
    || value.frameworkVersion !== V5_REPLAY_FRAMEWORK_VERSION
    || value.corpusPurpose !== "external-held-out-qualification"
    || value.acquisitionDataDomain !== "field"
    || value.replayDataDomain !== "test"
    || !isRecord(value.precommitment)
    || !isRecord(value.externalWitness)) throw new Error("V5 corpus manifest header is invalid");
  assertSafeId(value.corpusId, "corpusId");
  assertIso(value.createdAt, "corpus createdAt");
  validateCustody(value);
  validateFrozenIdentity(value.frozen);
  if (!Array.isArray(value.criteria) || !value.criteria.length || !Array.isArray(value.sessions) || !value.sessions.length || value.sessions.length > MAX_SESSIONS || !Array.isArray(value.files)) {
    throw new Error("V5 corpus criteria, sessions, or files are invalid");
  }
  value.criteria.forEach(validateCriterion);
  value.sessions.forEach(validateSessionEntry);
  safeRelativePath(value.precommitment.path, "precommitment path");
  assertSha256(value.precommitment.sha256, "precommitment sha256");
  assertSafeId(value.externalWitness.receiptId, "external witness receiptId");
  assertSha256(value.externalWitness.keySha256, "external witness keySha256");
  assertIso(value.externalWitness.signedAt, "external witness signedAt");
  assertIso(value.externalWitness.unblindingNotBefore, "external witness unblindingNotBefore");
  assertSha256(value.externalWitness.statementSha256, "external witness statementSha256");
  if (value.externalWitness.signatureAlgorithm !== "ed25519"
    || typeof value.externalWitness.signatureBase64 !== "string"
    || !/^[A-Za-z0-9+/]{80,128}={0,2}$/.test(value.externalWitness.signatureBase64)) {
    throw new Error("External V5 witness signature is invalid");
  }
  assertSha256(value.corpusTreeSha256, "corpus tree sha256");
  return value as unknown as V5ReplayCorpusManifest;
}

function validatePrecommitment(value: unknown): V5ReplayPrecommitment {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.recordType !== "rf-monitor-v5-held-out-precommitment" || !isRecord(value.custody)) {
    throw new Error("V5 precommitment is invalid");
  }
  assertSafeId(value.corpusId, "precommitment corpusId");
  assertIso(value.committedAt, "precommitment committedAt");
  validateFrozenIdentity(value.frozen);
  if (!Array.isArray(value.criteria) || !Array.isArray(value.sessions)) throw new Error("V5 precommitment coverage is invalid");
  value.criteria.forEach(validateCriterion);
  value.sessions.forEach(validateSessionEntry);
  for (const name of ["acquisitionCustodianIdHash", "truthLabelerIdHash", "detectorCustodianIdHash"] as const) assertSha256(value.custody[name], `precommitment ${name}`);
  if (typeof value.nonce !== "string" || !/^[a-f0-9]{64,256}$/.test(value.nonce)) throw new Error("V5 precommitment nonce is invalid");
  return value as unknown as V5ReplayPrecommitment;
}

function assertCandidateBinding(frozen: V5ReplayFrozenIdentity, candidate: V5CandidateContext): void {
  if (sha256CanonicalV5(frozen.release) !== sha256CanonicalV5(candidate.release)) throw new Error("V5 corpus release binding does not match the frozen candidate");
  if (frozen.configurationHash !== candidate.configurationHash || frozen.catalogVersion !== candidate.catalog.catalogVersion || frozen.catalogHash !== candidate.catalogHash) {
    throw new Error("V5 corpus configuration/catalog binding does not match the frozen candidate");
  }
  if (frozen.detectorRuleSetId !== candidate.operationalSettings.detection.ruleSetId
    || frozen.detectorRuleHash !== candidate.detectorRuleHash
    || frozen.detectorRuleHash !== detectionRuleFingerprint(frozen.detectorThresholds)
    || sha256CanonicalV5(frozen.detectorThresholds) !== sha256CanonicalV5(candidate.operationalSettings.detection)) {
    throw new Error("V5 corpus detector thresholds/rule hash do not match the frozen candidate; holdout tuning is forbidden");
  }
  if (frozen.alertingHash !== undefined && frozen.alertingHash !== alertingSettingsHash(candidate.operationalSettings.alerting)) {
    throw new Error("V5 corpus alert sensitivity does not match the frozen candidate; holdout tuning is forbidden");
  }
  const plan = detectorQualificationPlan(candidate.catalog);
  const expectedTargets = plan.targets.map((target) => target.id);
  if (sha256CanonicalV5(frozen.targetIds) !== sha256CanonicalV5(expectedTargets)
    || sha256CanonicalV5(frozen.families) !== sha256CanonicalV5([...V5_REPLAY_FAMILIES])) {
    throw new Error("V5 corpus does not cover the frozen Tier-1 target/family envelope");
  }
}

function validateCoverage(manifest: V5ReplayCorpusManifest): void {
  const criterionIds = new Set<string>();
  const sessionIds = new Set<string>();
  const pairIds = new Set<string>();
  for (const criterion of manifest.criteria) {
    if (criterionIds.has(criterion.criterionId)) throw new Error(`Duplicate V5 criterion ${criterion.criterionId}`);
    criterionIds.add(criterion.criterionId);
    const pair = `${criterion.targetId}:${criterion.family}`;
    if (pairIds.has(pair)) throw new Error(`Duplicate V5 target/family criterion ${pair}`);
    pairIds.add(pair);
    if (!manifest.frozen.targetIds.includes(criterion.targetId) || !manifest.frozen.families.includes(criterion.family)) throw new Error(`V5 criterion ${criterion.criterionId} is outside the frozen envelope`);
    for (const sessionId of criterion.sessionIds) {
      if (sessionIds.has(sessionId)) throw new Error(`V5 session ${sessionId} is assigned to more than one criterion`);
      sessionIds.add(sessionId);
    }
  }
  for (const targetId of manifest.frozen.targetIds) for (const family of manifest.frozen.families) {
    if (!pairIds.has(`${targetId}:${family}`)) throw new Error(`V5 criterion missing for ${targetId}/${family}`);
  }
  if (manifest.criteria.length !== manifest.frozen.targetIds.length * manifest.frozen.families.length) throw new Error("V5 criteria contain an unexpected target/family pair");
  if (sessionIds.size !== manifest.sessions.length) throw new Error("V5 predeclared session coverage does not match the corpus session count");
  const entryIds = new Set<string>();
  const acquisitionPaths = new Set<string>();
  for (const entry of manifest.sessions) {
    if (entryIds.has(entry.sessionId) || !sessionIds.has(entry.sessionId)) throw new Error(`V5 session entry ${entry.sessionId} is duplicated or undeclared`);
    entryIds.add(entry.sessionId);
    const criterion = manifest.criteria.find((candidate) => candidate.criterionId === entry.criterionId);
    if (!criterion?.sessionIds.includes(entry.sessionId)) throw new Error(`V5 session ${entry.sessionId} criterion binding is invalid`);
    if (acquisitionPaths.has(entry.descriptorPath)) throw new Error(`V5 descriptor path is reused: ${entry.descriptorPath}`);
    acquisitionPaths.add(entry.descriptorPath);
  }
}

function fileSizeBound(relativePath: string): number {
  if (relativePath === "precommitment.json") return MAX_PRECOMMITMENT_BYTES;
  if (relativePath.endsWith("/session.json")) return MAX_SESSION_DESCRIPTOR_BYTES;
  if (relativePath.endsWith("/truth.json")) return MAX_TRUTH_BYTES;
  if (relativePath.endsWith("/observations.jsonl")) return MAX_OBSERVATION_INDEX_BYTES;
  if (relativePath.endsWith("/fft.uint8")) return MAX_FFT_FILE_BYTES;
  if (relativePath.endsWith("/baseline-medians.uint8") || relativePath.endsWith("/baseline-mads.uint8")) return MAX_ANALYSIS_BINS;
  return MAX_SESSION_DESCRIPTOR_BYTES;
}

function verifyExternalWitness(
  manifest: V5ReplayCorpusManifest,
  precommitment: V5ReplayPrecommitment,
  witnessContext: V5WitnessContext,
): void {
  const { key, keySha256 } = witnessPublicKey(witnessContext);
  const witness = manifest.externalWitness;
  if (witness.keySha256 !== keySha256) throw new Error("V5 corpus witness key does not match the separately pinned witness key");
  if ([manifest.custody.acquisitionCustodianIdHash, manifest.custody.truthLabelerIdHash, manifest.custody.detectorCustodianIdHash].includes(keySha256)) {
    throw new Error("V5 external witness key must be distinct from acquisition, truth, and detector custody identities");
  }
  const statement = createV5WitnessStatement({
    corpusId: manifest.corpusId,
    precommitmentSha256: manifest.precommitment.sha256,
    precommitmentCommittedAt: precommitment.committedAt,
    signedAt: witness.signedAt,
    unblindingNotBefore: witness.unblindingNotBefore,
  });
  if (sha256CanonicalV5(statement) !== witness.statementSha256) throw new Error("V5 external witness statement hash mismatch");
  const committedAt = Date.parse(precommitment.committedAt);
  const signedAt = Date.parse(witness.signedAt);
  const notBefore = Date.parse(witness.unblindingNotBefore);
  const unblindedAt = Date.parse(manifest.custody.unblindedAt);
  if (committedAt > signedAt || signedAt > notBefore || notBefore > unblindedAt) {
    throw new Error("V5 external witness does not anchor precommitment before unblinding");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(witness.signatureBase64, "base64");
  } catch {
    throw new Error("V5 external witness signature is not valid base64");
  }
  if (signature.byteLength !== 64 || !verifySignature(null, v5WitnessMessage(statement), key, signature)) {
    throw new Error("V5 external witness signature verification failed");
  }
}

export async function validateV5ReplayCorpus(
  corpusPath: string,
  candidate: V5CandidateContext,
  witnessContext: V5WitnessContext,
): Promise<V5CorpusValidation> {
  const root = await canonicalDirectory(corpusPath, "V5 corpus root");
  const manifestBytes = await readBoundedBuffer(path.join(root, "corpus-manifest.json"), MAX_MANIFEST_BYTES);
  const manifest = validateCorpusManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  assertCandidateBinding(manifest.frozen, candidate);
  validateCoverage(manifest);

  const files = new Map<string, V5CorpusFileEntry>();
  let totalBytes = 0;
  for (const rawEntry of manifest.files) {
    if (!isRecord(rawEntry)) throw new Error("V5 corpus file entry is invalid");
    const relativePath = safeRelativePath(rawEntry.path, "corpus file path");
    assertInteger(rawEntry.bytes, `corpus file ${relativePath} bytes`, 0, fileSizeBound(relativePath));
    assertSha256(rawEntry.sha256, `corpus file ${relativePath} sha256`);
    if (relativePath === "corpus-manifest.json" || files.has(relativePath)) throw new Error(`V5 corpus file is reserved or duplicated: ${relativePath}`);
    totalBytes += rawEntry.bytes;
    if (totalBytes > MAX_CORPUS_BYTES || files.size >= MAX_CORPUS_FILES) throw new Error("V5 corpus exceeds its total file/byte bound");
    files.set(relativePath, rawEntry as unknown as V5CorpusFileEntry);
  }
  const diskFiles = await listCorpusFiles(root);
  const expectedFiles = ["corpus-manifest.json", ...files.keys()].sort();
  if (sha256CanonicalV5(diskFiles) !== sha256CanonicalV5(expectedFiles)) throw new Error("V5 corpus contains missing or undeclared files");
  const verifiedEntries: V5CorpusFileEntry[] = [];
  for (const entry of [...files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const actual = await hashRegularFile(resolveInside(root, entry.path), fileSizeBound(entry.path));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`V5 corpus file hash/size mismatch: ${entry.path}`);
    verifiedEntries.push(entry);
  }
  const treeHash = sha256CanonicalV5(verifiedEntries);
  if (treeHash !== manifest.corpusTreeSha256) throw new Error("V5 corpus tree hash mismatch");
  const precommitmentEntry = files.get(manifest.precommitment.path);
  if (!precommitmentEntry || precommitmentEntry.sha256 !== manifest.precommitment.sha256) throw new Error("V5 precommitment file is not hash-bound by the corpus manifest");
  const precommitment = validatePrecommitment(await readBoundedJson(resolveInside(root, manifest.precommitment.path), MAX_PRECOMMITMENT_BYTES, "V5 precommitment"));
  if (sha256CanonicalV5({
    corpusId: precommitment.corpusId,
    frozen: precommitment.frozen,
    criteria: precommitment.criteria,
    sessions: precommitment.sessions,
    custody: precommitment.custody,
  }) !== sha256CanonicalV5({
    corpusId: manifest.corpusId,
    frozen: manifest.frozen,
    criteria: manifest.criteria,
    sessions: manifest.sessions,
    custody: {
      acquisitionCustodianIdHash: manifest.custody.acquisitionCustodianIdHash,
      truthLabelerIdHash: manifest.custody.truthLabelerIdHash,
      detectorCustodianIdHash: manifest.custody.detectorCustodianIdHash,
    },
  })) throw new Error("V5 manifest differs from the pre-unblinding commitment");
  if (precommitment.committedAt !== manifest.custody.criteriaCommittedAt || Date.parse(precommitment.committedAt) > Date.parse(manifest.custody.unblindedAt)) {
    throw new Error("V5 precommitment was not sealed before unblinding");
  }
  verifyExternalWitness(manifest, precommitment, witnessContext);
  return {
    root,
    manifest,
    manifestSha256: sha256Bytes(manifestBytes),
    corpusTreeSha256: treeHash,
    precommitmentSha256: precommitmentEntry.sha256,
    fileCount: files.size + 1,
    totalBytes: totalBytes + manifestBytes.byteLength,
  };
}

function validateSessionDescriptor(value: unknown, entry: V5ReplayCorpusSessionEntry, manifest: V5ReplayCorpusManifest): V5SessionDescriptor {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.recordType !== "rf-monitor-v5-held-out-fft-session"
    || value.independentSession !== true
    || !isRecord(value.source)
    || !isRecord(value.receiver)
    || !isRecord(value.sdrconnect)
    || !isRecord(value.target)
    || !isRecord(value.grid)
    || !isRecord(value.fingerprint)
    || !isRecord(value.baseline)
    || !isRecord(value.observations)
    || !isRecord(value.truth)) throw new Error(`V5 session ${entry.sessionId} descriptor is invalid`);
  if (value.sessionId !== entry.sessionId || value.criterionId !== entry.criterionId) throw new Error(`V5 session ${entry.sessionId} identity mismatch`);
  assertSafeId(value.acquisitionId, "acquisitionId");
  const source = value.source;
  if (source.kind !== "real-receiver-normalized-fft" || source.acquisitionDataDomain !== "field" || source.normalizedEncoding !== "uint8"
    || source.realReceiver !== true || source.synthetic !== false || source.simulation !== false || source.replay !== false || source.iq !== false) {
    throw new Error(`V5 session ${entry.sessionId} is not an isolated real normalized-uint8 field acquisition`);
  }
  const receiverModel = parseSupportedReceiverModel(value.receiver.model);
  if (!receiverModel || receiverModel !== value.receiver.model) throw new Error(`V5 session ${entry.sessionId} receiver model is unsupported or noncanonical`);
  assertSha256(value.receiver.serialSha256, `V5 session ${entry.sessionId} serial hash`);
  if (typeof value.sdrconnect.version !== "string" || !value.sdrconnect.version.trim() || value.sdrconnect.version.length > 128
    || value.sdrconnect.sampleRateReadBackConfirmed !== true || value.sdrconnect.fftValues !== "normalized-uint8-display-values") {
    throw new Error(`V5 session ${entry.sessionId} SDRconnect provenance is incomplete`);
  }
  assertSafeId(value.target.id, "session targetId");
  assertSafeId(value.target.bandId, "session bandId");
  if (!Array.isArray(value.target.affectedBandIds) || !value.target.affectedBandIds.length) throw new Error(`V5 session ${entry.sessionId} affected bands are missing`);
  const target = manifest.frozen.targetIds.includes(value.target.id as string) ? value.target.id as string : "";
  if (!target) throw new Error(`V5 session ${entry.sessionId} target is outside the frozen envelope`);
  assertInteger(value.grid.inputBinCount, "inputBinCount", 1, MAX_INPUT_BINS);
  assertInteger(value.grid.analysisStartBin, "analysisStartBin", 0, value.grid.inputBinCount as number);
  assertInteger(value.grid.analysisEndBin, "analysisEndBin", (value.grid.analysisStartBin as number) + 1, value.grid.inputBinCount as number);
  if ((value.grid.analysisEndBin as number) - (value.grid.analysisStartBin as number) > MAX_ANALYSIS_BINS || value.grid.sampleRateHz !== PRODUCTION_SAMPLE_RATE_HZ) {
    throw new Error(`V5 session ${entry.sessionId} FFT grid is outside the bounded production envelope`);
  }
  assertSha256(value.grid.analysisMaskHash, "analysisMaskHash");
  assertFinite(value.grid.spectrumReference, "spectrumReference");
  assertFinite(value.grid.spectrumBase, "spectrumBase");
  const targetDescriptor = value.target;
  for (const field of ["centerHz", "captureSpanHz", "analysisSpanHz"] as const) assertFinite(targetDescriptor[field], `target ${field}`, 1);
  if ((targetDescriptor.analysisSpanHz as number) > MAX_ANALYSIS_SPAN_HZ || (targetDescriptor.analysisSpanHz as number) > (targetDescriptor.captureSpanHz as number)) {
    throw new Error(`V5 session ${entry.sessionId} analysis span is invalid`);
  }
  const expectedMask = centralAnalysisBinBounds(
    value.grid.inputBinCount as number,
    targetDescriptor.analysisSpanHz as number,
    targetDescriptor.captureSpanHz as number,
  );
  if (value.grid.analysisStartBin !== expectedMask.startBin || value.grid.analysisEndBin !== expectedMask.endBin) {
    throw new Error(`V5 session ${entry.sessionId} analysis mask is not the exact central configured span`);
  }
  if (value.grid.analysisMaskHash !== sha256CanonicalV5({
    inputBinCount: value.grid.inputBinCount,
    analysisStartBin: value.grid.analysisStartBin,
    analysisEndBin: value.grid.analysisEndBin,
    analysisSpanHz: targetDescriptor.analysisSpanHz,
    captureSpanHz: targetDescriptor.captureSpanHz,
  })) throw new Error(`V5 session ${entry.sessionId} analysis-mask hash mismatch`);
  const fingerprint = value.fingerprint as unknown as BaselineFingerprint;
  if (fingerprint.schemaVersion !== 1 || fingerprint.dataDomain !== "field" || fingerprint.targetId !== value.target.id
    || fingerprint.centerHz !== value.target.centerHz || fingerprint.sampleRateHz !== value.grid.sampleRateHz
    || fingerprint.inputBinCount !== value.grid.inputBinCount || fingerprint.analysisStartBin !== value.grid.analysisStartBin
    || fingerprint.analysisEndBin !== value.grid.analysisEndBin || fingerprint.analysisMaskHash !== value.grid.analysisMaskHash
    || fingerprint.spectrumReference !== value.grid.spectrumReference || fingerprint.spectrumBase !== value.grid.spectrumBase
    || fingerprint.catalogVersion !== manifest.frozen.catalogVersion || fingerprint.detectionRuleHash !== manifest.frozen.detectorRuleHash
    || fingerprint.detectorVersion !== manifest.frozen.detectorVersion || fingerprint.sdrconnectVersion !== value.sdrconnect.version
    || fingerprint.deviceName !== receiverModel || fingerprint.receiverIdentity !== `hardware:${receiverModel}:${value.receiver.serialSha256}`
    || fingerprint.receiverKey !== `rspdx:${value.receiver.serialSha256}` || fingerprint.deviceSerial !== undefined
    || !fingerprint.activeAntenna?.trim() || !fingerprint.gainProfileId?.trim()) {
    throw new Error(`V5 session ${entry.sessionId} exact baseline fingerprint binding is invalid`);
  }
  if (value.fingerprintId !== baselineFingerprintId(fingerprint)) throw new Error(`V5 session ${entry.sessionId} fingerprint id mismatch`);
  const descriptor = value.baseline.descriptor as unknown as BaselineDescriptor;
  if (descriptor.dataDomain !== "field" || descriptor.targetId !== value.target.id || descriptor.lifecycle !== "protected"
    || descriptor.fingerprintId !== value.fingerprintId || !descriptor.baselineId || !descriptor.learningGenerationId
    || descriptor.observationCount < 64 || descriptor.representativeHours < 24 || !descriptor.protectedAt) {
    throw new Error(`V5 session ${entry.sessionId} requires an exact protected reference baseline`);
  }
  for (const [field, limit] of [["mediansPath", MAX_ANALYSIS_BINS], ["madsPath", MAX_ANALYSIS_BINS]] as const) {
    const relativePath = safeRelativePath(value.baseline[field], `baseline ${field}`);
    if (!manifest.files.some((candidate) => candidate.path === relativePath && candidate.bytes <= limit)) throw new Error(`V5 session ${entry.sessionId} ${field} is not corpus-bound`);
  }
  const observations = value.observations;
  for (const field of ["recordCount", "validRecordCount", "unknownRecordCount"] as const) assertInteger(observations[field], `observations ${field}`, 0, MAX_OBSERVATIONS_PER_SESSION);
  if ((observations.validRecordCount as number) + (observations.unknownRecordCount as number) !== observations.recordCount || (observations.recordCount as number) <= 0) throw new Error(`V5 session ${entry.sessionId} observation counts are invalid`);
  safeRelativePath(observations.indexPath, "observation index path");
  safeRelativePath(observations.fftPath, "FFT path");
  if (!manifest.files.some((candidate) => candidate.path === observations.indexPath) || !manifest.files.some((candidate) => candidate.path === observations.fftPath)) throw new Error(`V5 session ${entry.sessionId} observation files are not corpus-bound`);
  const truth = value.truth;
  safeRelativePath(truth.disclosurePath, "truth disclosure path");
  if (truth.commitmentAlgorithm !== "sha256-canonical-json" || truth.commitment !== entry.truthCommitment
    || !manifest.files.some((candidate) => candidate.path === truth.disclosurePath)) throw new Error(`V5 session ${entry.sessionId} truth binding is invalid`);
  return value as unknown as V5SessionDescriptor;
}

function validateTruth(value: unknown, descriptor: V5SessionDescriptor, entry: V5ReplayCorpusSessionEntry, criterion: V5ReplayCriterion, manifest: V5ReplayCorpusManifest): V5TruthDisclosure {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.recordType !== "rf-monitor-v5-held-out-truth" || !isRecord(value.eventWindow) || !isRecord(value.measuredParameters)) {
    throw new Error(`V5 session ${entry.sessionId} truth disclosure is invalid`);
  }
  if (value.sessionId !== entry.sessionId || value.criterionId !== entry.criterionId || value.targetId !== criterion.targetId
    || value.family !== criterion.family || value.expectedOutcome !== criterion.expectedOutcome || value.envelopeId !== criterion.testedEnvelope.envelopeId
    || value.withinPredeclaredEnvelope !== true || value.truthLabelerIdHash !== manifest.custody.truthLabelerIdHash) {
    throw new Error(`V5 session ${entry.sessionId} truth differs from the predeclared criterion`);
  }
  assertFinite(value.eventWindow.startMonotonicMs, "truth event start", 0);
  assertFinite(value.eventWindow.endMonotonicMs, "truth event end", (value.eventWindow.startMonotonicMs as number) + 1);
  assertFinite(value.eventWindow.alertGraceMs, "truth alert grace", 0, 30_000);
  assertIso(value.committedAt, "truth committedAt");
  if (Date.parse(value.committedAt as string) > Date.parse(manifest.custody.unblindedAt)) throw new Error(`V5 session ${entry.sessionId} truth was committed after unblinding`);
  if (typeof value.nonce !== "string" || !/^[a-f0-9]{64,256}$/.test(value.nonce)) throw new Error(`V5 session ${entry.sessionId} truth nonce is invalid`);
  const disclosure = value as unknown as V5TruthDisclosure;
  if (sha256CanonicalV5(disclosure) !== entry.truthCommitment || descriptor.truth.commitment !== entry.truthCommitment) throw new Error(`V5 session ${entry.sessionId} truth commitment mismatch`);
  return disclosure;
}

function validateObservation(value: unknown, descriptor: V5SessionDescriptor, sequence: number): V5ObservationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.sequence !== sequence || (value.outcome !== "valid" && value.outcome !== "unknown")) {
    throw new Error(`V5 observation ${sequence} is invalid`);
  }
  assertIso(value.observedAt, `observation ${sequence} observedAt`);
  assertInteger(value.intentionalDiscardedFrames, `observation ${sequence} intentional discards`, 0, 1_000_000);
  if (value.outcome === "unknown") {
    assertFinite(value.startMonotonicMs, `unknown ${sequence} start`, 0);
    assertFinite(value.endMonotonicMs, `unknown ${sequence} end`, value.startMonotonicMs as number);
    if (!UNKNOWN_REASONS.has(value.reason as TargetVisitUnknownReason)) throw new Error(`V5 unknown observation ${sequence} reason is invalid`);
    return value as unknown as V5UnknownObservationRecord;
  }
  assertSafeId(value.visitId, `observation ${sequence} visitId`);
  assertFinite(value.firstMonotonicMs, `observation ${sequence} first monotonic`, 0);
  assertFinite(value.lastMonotonicMs, `observation ${sequence} last monotonic`, value.firstMonotonicMs as number);
  assertInteger(value.exposureMs, `observation ${sequence} exposure`, 0, 60_000);
  if (value.exposureMs !== Math.floor((value.lastMonotonicMs as number) - (value.firstMonotonicMs as number))) throw new Error(`V5 observation ${sequence} exposure is inconsistent`);
  assertInteger(value.acceptedFrameCount, `observation ${sequence} accepted frames`, 3, 5);
  assertInteger(value.rawOffset, `observation ${sequence} raw offset`, 0);
  if (value.rawLength !== descriptor.grid.inputBinCount) throw new Error(`V5 observation ${sequence} raw FFT length does not match the native grid`);
  for (const field of ["configurationEpoch", "tuneEpoch", "visitEpoch"] as const) assertInteger(value[field], `observation ${sequence} ${field}`, 1);
  if (value.confirmedCenterHz !== descriptor.target.centerHz || value.confirmedSampleRateHz !== descriptor.grid.sampleRateHz || value.healthComplete !== true || typeof value.overload !== "boolean") {
    throw new Error(`V5 observation ${sequence} confirmed RF/health state is invalid`);
  }
  assertIso(value.tuneConfirmedAt, `observation ${sequence} tuneConfirmedAt`);
  return value as unknown as V5ValidObservationRecord;
}

async function readObservationIndex(root: string, descriptor: V5SessionDescriptor, manifest: V5ReplayCorpusManifest): Promise<V5ObservationRecord[]> {
  const indexBytes = await readBoundCorpusBuffer(
    root,
    manifest,
    descriptor.observations.indexPath,
    MAX_OBSERVATION_INDEX_BYTES,
    `V5 session ${descriptor.sessionId} observation index`,
  );
  const records: V5ObservationRecord[] = [];
  let validCount = 0;
  let unknownCount = 0;
  let expectedOffset = 0;
  let previousEnd = -1;
  for (const line of indexBytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_OBSERVATION_LINE_BYTES || records.length >= MAX_OBSERVATIONS_PER_SESSION) throw new Error(`V5 session ${descriptor.sessionId} observation index exceeds its bound`);
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { throw new Error(`V5 session ${descriptor.sessionId} observation JSONL is malformed`); }
    const record = validateObservation(parsed, descriptor, records.length);
    const start = record.outcome === "valid" ? record.firstMonotonicMs : record.startMonotonicMs;
    const end = record.outcome === "valid" ? record.lastMonotonicMs : record.endMonotonicMs;
    if (start < previousEnd) throw new Error(`V5 session ${descriptor.sessionId} observation times overlap or regress`);
    previousEnd = end;
    if (record.outcome === "valid") {
      if (record.rawOffset !== expectedOffset) throw new Error(`V5 session ${descriptor.sessionId} FFT offsets are not contiguous`);
      expectedOffset += record.rawLength;
      validCount += 1;
    } else unknownCount += 1;
    records.push(record);
  }
  if (records.length !== descriptor.observations.recordCount || validCount !== descriptor.observations.validRecordCount || unknownCount !== descriptor.observations.unknownRecordCount) {
    throw new Error(`V5 session ${descriptor.sessionId} observation counts do not match its descriptor`);
  }
  const fftEntryBytes = expectedOffset;
  const fftDetails = await openRegularNoFollow(resolveInside(root, descriptor.observations.fftPath), MAX_FFT_FILE_BYTES, expectedOffset === 0);
  try {
    if (fftDetails.bytes !== fftEntryBytes) throw new Error(`V5 session ${descriptor.sessionId} FFT file has trailing or missing bytes`);
  } finally {
    await fftDetails.handle.close();
  }
  return records;
}

async function loadSessions(validation: V5CorpusValidation): Promise<LoadedSession[]> {
  const sessions: LoadedSession[] = [];
  const acquisitionIds = new Set<string>();
  for (const entry of validation.manifest.sessions) {
    const descriptorBytes = await readBoundCorpusBuffer(
      validation.root,
      validation.manifest,
      entry.descriptorPath,
      MAX_SESSION_DESCRIPTOR_BYTES,
      `V5 session ${entry.sessionId} descriptor`,
    );
    if (sha256Bytes(descriptorBytes) !== entry.descriptorSha256) throw new Error(`V5 session ${entry.sessionId} descriptor hash mismatch`);
    const descriptor = validateSessionDescriptor(JSON.parse(descriptorBytes.toString("utf8")) as unknown, entry, validation.manifest);
    if (acquisitionIds.has(descriptor.acquisitionId)) throw new Error(`V5 independent sessions reuse acquisition id ${descriptor.acquisitionId}`);
    acquisitionIds.add(descriptor.acquisitionId);
    const criterion = validation.manifest.criteria.find((candidate) => candidate.criterionId === entry.criterionId)!;
    const truth = validateTruth(
      await readBoundCorpusJson(validation.root, validation.manifest, descriptor.truth.disclosurePath, MAX_TRUTH_BYTES, `V5 session ${entry.sessionId} truth`),
      descriptor,
      entry,
      criterion,
      validation.manifest,
    );
    const observations = await readObservationIndex(validation.root, descriptor, validation.manifest);
    sessions.push({ entry, manifest: validation.manifest, descriptor, truth, observations });
  }
  return sessions;
}

function catalogTarget(catalog: BandCatalog, descriptor: V5SessionDescriptor): PhysicalCaptureTarget {
  const target = catalog.captureTargets.find((candidate) => candidate.id === descriptor.target.id);
  if (!target || target.service !== "gnss" || target.tier !== "tier1" || !target.defaultEnabled) throw new Error(`V5 session ${descriptor.sessionId} target is not an active Tier-1 catalog target`);
  if (target.label !== descriptor.target.label || target.centerHz !== descriptor.target.centerHz || target.captureSpanHz !== descriptor.target.captureSpanHz
    || target.analysisSpanHz !== descriptor.target.analysisSpanHz || sha256CanonicalV5(target.relatedBandIds) !== sha256CanonicalV5(descriptor.target.affectedBandIds)
    || descriptor.target.bandId !== target.relatedBandIds[0]) throw new Error(`V5 session ${descriptor.sessionId} target provenance differs from the catalog`);
  return target;
}

function bandForTarget(target: PhysicalCaptureTarget, descriptor: V5SessionDescriptor): BandPreset {
  return {
    id: descriptor.target.bandId,
    label: target.label,
    service: "gnss",
    startHz: target.centerHz - target.analysisSpanHz / 2,
    endHz: target.centerHz + target.analysisSpanHz / 2,
    centerHz: target.centerHz,
    captureTargetId: target.id,
    captureCenterHz: target.centerHz,
    captureSpanHz: target.captureSpanHz,
    analysisSpanHz: target.analysisSpanHz,
    priority: 1,
    dwellMs: target.nominalVisitMs,
    editable: false,
  };
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function mergedExposure(records: V5ValidObservationRecord[], start: number, end: number): number {
  const spans = records
    .map((record) => [Math.max(start, record.firstMonotonicMs), Math.min(end, record.lastMonotonicMs)] as const)
    .filter(([left, right]) => right > left)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let currentStart = 0;
  let currentEnd = 0;
  for (const [left, right] of spans) {
    if (currentEnd <= currentStart) { currentStart = left; currentEnd = right; continue; }
    if (left > currentEnd) { total += currentEnd - currentStart; currentStart = left; currentEnd = right; }
    else currentEnd = Math.max(currentEnd, right);
  }
  return total + Math.max(0, currentEnd - currentStart);
}

async function readUint8File(root: string, manifest: V5ReplayCorpusManifest, relativePath: string, expectedBytes: number): Promise<Uint8Array> {
  const buffer = await readBoundCorpusBuffer(root, manifest, relativePath, expectedBytes, `V5 uint8 array ${relativePath}`);
  if (buffer.byteLength !== expectedBytes) throw new Error(`V5 uint8 array ${relativePath} has the wrong length`);
  return Uint8Array.from(buffer);
}

async function scoreSession(root: string, loaded: LoadedSession, thresholds: DetectionThresholds, catalog: BandCatalog): Promise<V5SessionScore> {
  const { descriptor, truth, observations, entry, manifest } = loaded;
  const target = catalogTarget(catalog, descriptor);
  const band = bandForTarget(target, descriptor);
  const analysisBins = descriptor.grid.analysisEndBin - descriptor.grid.analysisStartBin;
  const [medians, mads] = await Promise.all([
    readUint8File(root, manifest, descriptor.baseline.mediansPath, analysisBins),
    readUint8File(root, manifest, descriptor.baseline.madsPath, analysisBins),
  ]);
  const detector = new DetectionEngine(structuredClone(thresholds), () => 0.5);
  const validRecords = observations.filter((record): record is V5ValidObservationRecord => record.outcome === "valid");
  const unknownRecords = observations.filter((record): record is V5UnknownObservationRecord => record.outcome === "unknown");
  const eventStart = truth.eventWindow.startMonotonicMs;
  const eventEnd = truth.eventWindow.endMonotonicMs;
  const graceEnd = eventEnd + truth.eventWindow.alertGraceMs;
  const alerts: Array<{ monotonicMs: number; kind: DetectionKind }> = [];
  const fftEntry = corpusFileEntry(manifest, descriptor.observations.fftPath, `V5 session ${descriptor.sessionId} FFT`);
  const fft = await openRegularNoFollow(resolveInside(root, descriptor.observations.fftPath), Math.min(MAX_FFT_FILE_BYTES, fftEntry.bytes), descriptor.observations.validRecordCount === 0);
  const fftHash = createHash("sha256");
  try {
    for (const record of validRecords) {
      const raw = Buffer.allocUnsafe(record.rawLength);
      const read = await fft.handle.read(raw, 0, raw.byteLength, record.rawOffset);
      if (read.bytesRead !== raw.byteLength) throw new Error(`V5 session ${descriptor.sessionId} FFT record is truncated`);
      fftHash.update(raw);
      const bins = Uint8Array.from(raw.subarray(descriptor.grid.analysisStartBin, descriptor.grid.analysisEndBin));
      const observedAtMs = Date.parse(record.observedAt);
      const firstFrameAt = new Date(observedAtMs - record.exposureMs).toISOString();
      const observation: TargetObservation = {
        dataDomain: "field",
        id: `${descriptor.sessionId}-observation-${record.sequence}`,
        visitId: record.visitId,
        configurationEpoch: record.configurationEpoch,
        tuneEpoch: record.tuneEpoch,
        visitEpoch: record.visitEpoch,
        targetId: target.id,
        receiver: 0,
        bandId: descriptor.target.bandId,
        affectedBandIds: [...descriptor.target.affectedBandIds],
        observedAt: record.observedAt,
        firstFrameAt,
        lastFrameAt: record.observedAt,
        exposureMs: record.exposureMs,
        acceptedFrameCount: record.acceptedFrameCount,
        bins,
        confirmedCenterHz: record.confirmedCenterHz,
        confirmedSampleRateHz: record.confirmedSampleRateHz,
        tuneConfirmedAt: record.tuneConfirmedAt,
        fingerprint: descriptor.fingerprint,
        overload: record.overload,
        healthComplete: true,
      };
      const result = detector.analyzeObservation(observation, band, {
        freezeTraining: true,
        expectedVisit: true,
        requireReferenceBaseline: true,
        referenceBaseline: { descriptor: descriptor.baseline.descriptor, medians, mads },
      });
      if (result.trainingEligible) throw new Error(`V5 session ${descriptor.sessionId} attempted to train on held-out data`);
      if (result.event) alerts.push({ monotonicMs: record.lastMonotonicMs, kind: result.event.kind });
    }
    if (fft.bytes !== fftEntry.bytes || fftHash.digest("hex") !== fftEntry.sha256) {
      throw new Error(`V5 session ${descriptor.sessionId} FFT changed after the corpus was validated`);
    }
  } finally {
    await fft.handle.close();
  }
  const overlappingValid = validRecords.filter((record) => overlaps(record.firstMonotonicMs, record.lastMonotonicMs, eventStart, eventEnd));
  const overlappingUnknown = unknownRecords.filter((record) => overlaps(record.startMonotonicMs, record.endMonotonicMs, eventStart, eventEnd));
  const observedEventExposureMs = mergedExposure(overlappingValid, eventStart, eventEnd);
  const matchingAlerts = alerts.filter((alert) => alert.monotonicMs >= eventStart && alert.monotonicMs <= graceEnd
    && (truth.family === "overload" ? alert.kind === "overload" : alert.kind !== "overload"));
  const unexpectedAlerts = alerts.length - matchingAlerts.length;
  let verdict: V5SessionVerdict;
  if (truth.expectedOutcome === "alert") {
    if (matchingAlerts.length && observedEventExposureMs > 0 && unexpectedAlerts === 0) verdict = "detected";
    else if (unexpectedAlerts > 0) verdict = "unexpected-alert";
    else if (overlappingUnknown.length) verdict = "unknown";
    else if (observedEventExposureMs <= 0) verdict = "unobserved";
    else verdict = "missed";
  } else if (truth.expectedOutcome === "no-alert") {
    if (alerts.length) verdict = "false-alert";
    else if (overlappingUnknown.length) verdict = "unknown";
    else if (observedEventExposureMs <= 0) verdict = "unobserved";
    else verdict = "alert-free";
  } else {
    if (alerts.length) verdict = "unexpected-alert";
    else if (overlappingUnknown.length) verdict = "unknown-observed";
    else if (observedEventExposureMs <= 0) verdict = "unobserved";
    else verdict = "unknown-not-observed";
  }
  const firstAlert = matchingAlerts[0];
  const latency = firstAlert ? (() => {
    const wallClockMs = Math.max(0, firstAlert.monotonicMs - eventStart);
    const observedExposureMs = mergedExposure(validRecords, eventStart, firstAlert.monotonicMs);
    return { wallClockMs, observedExposureMs, unobservedMs: Math.max(0, wallClockMs - observedExposureMs) };
  })() : undefined;
  return {
    sessionId: descriptor.sessionId,
    criterionId: descriptor.criterionId,
    targetId: descriptor.target.id,
    family: truth.family,
    expectedOutcome: truth.expectedOutcome,
    verdict,
    truthCommitment: entry.truthCommitment,
    truthVerified: true,
    validObservations: validRecords.length,
    unknownObservations: unknownRecords.length,
    observedEventExposureMs,
    detected: verdict === "detected",
    alertFree: verdict === "alert-free",
    unknown: verdict === "unknown" || verdict === "unknown-observed" || verdict === "unknown-not-observed",
    unobserved: verdict === "unobserved",
    alertKinds: alerts.map((alert) => alert.kind),
    unexpectedAlerts,
    ...(latency ? { latency } : {}),
  };
}

function aggregateCriterion(criterion: V5ReplayCriterion, sessions: V5SessionScore[]): V5CriterionScore {
  const selected = sessions.filter((session) => session.criterionId === criterion.criterionId);
  const detections = selected.filter((session) => session.verdict === "detected").length;
  const misses = selected.filter((session) => session.verdict === "missed" || session.verdict === "unexpected-alert").length;
  const alertFree = selected.filter((session) => session.verdict === "alert-free").length;
  const falseAlerts = selected.filter((session) => session.verdict === "false-alert" || session.verdict === "unexpected-alert").length;
  const unknown = selected.filter((session) => session.unknown).length;
  const unobserved = selected.filter((session) => session.unobserved).length;
  const unknownExpectedSuccesses = selected.filter((session) => session.verdict === "unknown-observed").length;
  const evaluableSessions = criterion.expectedOutcome === "alert" ? detections + misses
    : criterion.expectedOutcome === "no-alert" ? alertFree + falseAlerts
      : selected.length - unobserved;
  const successes = criterion.expectedOutcome === "alert" ? detections : criterion.expectedOutcome === "no-alert" ? alertFree : unknownExpectedSuccesses;
  const failures = Math.max(0, evaluableSessions - successes);
  const interval = criterion.expectedOutcome !== "unknown" && evaluableSessions > 0
    ? binomialWilsonOneSidedInterval(successes, evaluableSessions, CONFIDENCE)
    : null;
  const reasons: string[] = [];
  if (selected.length !== criterion.sessionIds.length || selected.length < criterion.minimumIndependentSessions) reasons.push("predeclared-independent-session-count-not-met");
  if (criterion.expectedOutcome !== "unknown" && evaluableSessions < criterion.minimumIndependentSessions) reasons.push("minimum-evaluable-independent-sessions-not-met");
  if (criterion.expectedOutcome !== "unknown" && unknown / Math.max(1, selected.length) > criterion.maximumUnknownFraction) reasons.push("unknown-fraction-exceeded");
  if (unobserved / Math.max(1, selected.length) > criterion.maximumUnobservedFraction) reasons.push("unobserved-fraction-exceeded");
  if (criterion.expectedOutcome === "unknown") {
    if (successes !== selected.length) reasons.push("unknown-control-not-always-unknown");
  } else if (!interval || interval.lower < criterion.requiredWilsonLowerBound!) reasons.push("one-sided-wilson-lower-bound-not-met");
  if (selected.some((session) => session.unexpectedAlerts > 0)) reasons.push("unexpected-alert-observed");
  return {
    criterionId: criterion.criterionId,
    targetId: criterion.targetId,
    family: criterion.family,
    expectedOutcome: criterion.expectedOutcome,
    sessions: selected.length,
    evaluableSessions,
    successes,
    failures,
    detections,
    misses,
    alertFree,
    falseAlerts,
    unknown,
    unobserved,
    interval,
    requiredWilsonLowerBound: criterion.requiredWilsonLowerBound,
    minimumIndependentSessions: criterion.minimumIndependentSessions,
    maximumUnknownFraction: criterion.maximumUnknownFraction,
    maximumUnobservedFraction: criterion.maximumUnobservedFraction,
    passed: reasons.length === 0,
    failureReasons: reasons,
  };
}

async function snapshotProtectedFieldTree(rootPath: string): Promise<ProtectedTreeSnapshot> {
  const root = path.resolve(rootPath);
  let details;
  try { details = await lstat(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", root, entries: 0, bytes: 0, sha256: sha256Bytes(`absent:${root}`) };
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Protected field root must be a real directory or absent");
  const digest = createHash("sha256");
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const childDetails = await lstat(absolute);
      entries += 1;
      if (entries > MAX_PROTECTED_TREE_ENTRIES) return { state: "bound-exceeded", root, entries, bytes, reason: "protected-field-entry-bound" };
      if (childDetails.isDirectory() && !childDetails.isSymbolicLink()) pending.push(absolute);
      else if (childDetails.isFile() && !childDetails.isSymbolicLink()) {
        bytes += childDetails.size;
        if (bytes > MAX_PROTECTED_TREE_BYTES) return { state: "bound-exceeded", root, entries, bytes, reason: "protected-field-byte-bound" };
        const hashed = await hashRegularFile(absolute, MAX_PROTECTED_TREE_BYTES,);
        digest.update(`${relative}\0${hashed.bytes}\0${hashed.sha256}\0`);
      } else throw new Error(`Protected field tree contains a symbolic link or non-regular entry: ${relative}`);
    }
  }
  return { state: "verified", root, entries, bytes, sha256: digest.digest("hex") };
}

function sameProtectedTree(left: ProtectedTreeSnapshot, right: ProtectedTreeSnapshot): boolean {
  return left.state !== "bound-exceeded" && sha256CanonicalV5(left) === sha256CanonicalV5(right);
}

function deterministicProtectedTree(snapshot: ProtectedTreeSnapshot): Omit<ProtectedTreeSnapshot, "root"> {
  const { root: _hostPath, ...portable } = snapshot;
  return portable;
}

export async function runV5HeldOutReplay(options: V5ReplayOptions): Promise<V5ReplayReport> {
  const protectedRoot = await canonicalPotentialDirectory(options.protectedFieldRoot, "Protected field root");
  const corpusResolved = await canonicalDirectory(options.corpusRoot, "V5 corpus root");
  if (pathsOverlap(protectedRoot, corpusResolved)) throw new Error("V5 corpus must be a read-only qualification copy outside the protected field-data root");
  const before = await snapshotProtectedFieldTree(protectedRoot);
  if (before.state === "bound-exceeded") throw new Error("Protected field tree exceeds the V5 isolation verification bound");
  const validationBefore = await validateV5ReplayCorpus(corpusResolved, options.candidate, options.witness);
  const loaded = await loadSessions(validationBefore);
  const scores: V5SessionScore[] = [];
  for (const session of loaded) scores.push(await scoreSession(validationBefore.root, session, validationBefore.manifest.frozen.detectorThresholds, options.candidate.catalog));
  const validationAfter = await validateV5ReplayCorpus(corpusResolved, options.candidate, options.witness);
  if (validationBefore.manifestSha256 !== validationAfter.manifestSha256 || validationBefore.corpusTreeSha256 !== validationAfter.corpusTreeSha256) {
    throw new Error("V5 corpus changed during replay");
  }
  const after = await snapshotProtectedFieldTree(protectedRoot);
  const fieldUnchanged = sameProtectedTree(before, after);
  if (!fieldUnchanged) throw new Error("Protected field data changed during isolated V5 replay");
  const criteria = validationBefore.manifest.criteria.map((criterion) => aggregateCriterion(criterion, scores));
  const allCriteriaPassed = criteria.every((criterion) => criterion.passed);
  const deterministicPayload = {
    frameworkVersion: V5_REPLAY_FRAMEWORK_VERSION,
    release: options.candidate.release,
    corpus: {
      corpusId: validationBefore.manifest.corpusId,
      manifestSha256: validationBefore.manifestSha256,
      treeSha256: validationBefore.corpusTreeSha256,
      precommitmentSha256: validationBefore.precommitmentSha256,
    },
    externalWitness: {
      receiptId: validationBefore.manifest.externalWitness.receiptId,
      keySha256: validationBefore.manifest.externalWitness.keySha256,
      precommitmentCommittedAt: validationBefore.manifest.custody.criteriaCommittedAt,
      signedAt: validationBefore.manifest.externalWitness.signedAt,
      unblindingNotBefore: validationBefore.manifest.externalWitness.unblindingNotBefore,
      statementSha256: validationBefore.manifest.externalWitness.statementSha256,
      signatureAlgorithm: validationBefore.manifest.externalWitness.signatureAlgorithm,
      signatureBase64: validationBefore.manifest.externalWitness.signatureBase64,
    },
    sessions: scores,
    criteria,
    fieldTree: { before: deterministicProtectedTree(before), after: deterministicProtectedTree(after) },
  };
  const now = options.now?.() ?? new Date();
  const runId = options.runId ?? `${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  assertSafeId(runId, "V5 runId");
  return {
    schemaVersion: V5_REPLAY_SCHEMA_VERSION,
    recordType: "rf-monitor-v5-held-out-replay-result",
    frameworkVersion: V5_REPLAY_FRAMEWORK_VERSION,
    gate: "V5",
    generatedAt: now.toISOString(),
    runId,
    release: options.candidate.release,
    corpus: {
      corpusId: validationBefore.manifest.corpusId,
      manifestSha256: validationBefore.manifestSha256,
      treeSha256: validationBefore.corpusTreeSha256,
      precommitmentSha256: validationBefore.precommitmentSha256,
      files: validationBefore.fileCount,
      bytes: validationBefore.totalBytes,
    },
    protocol: {
      input: "real normalized uint8 FFT",
      scoringUnit: "independent-session",
      confidence: CONFIDENCE,
      confidenceMethod: "one-sided-wilson",
      detectorTraining: "frozen",
      thresholdMutationAllowed: false,
      replayDataDomain: "test",
    },
    externalWitness: {
      receiptId: validationBefore.manifest.externalWitness.receiptId,
      keySha256: validationBefore.manifest.externalWitness.keySha256,
      precommitmentCommittedAt: validationBefore.manifest.custody.criteriaCommittedAt,
      signedAt: validationBefore.manifest.externalWitness.signedAt,
      unblindingNotBefore: validationBefore.manifest.externalWitness.unblindingNotBefore,
      statementSha256: validationBefore.manifest.externalWitness.statementSha256,
      signatureAlgorithm: validationBefore.manifest.externalWitness.signatureAlgorithm,
      signatureBase64: validationBefore.manifest.externalWitness.signatureBase64,
      signatureVerified: true,
    },
    isolation: { before, after, unchanged: fieldUnchanged },
    sessions: scores,
    criteria,
    byTargetFamily: criteria,
    counts: {
      sessions: scores.length,
      detected: scores.filter((score) => score.verdict === "detected").length,
      missed: scores.filter((score) => score.verdict === "missed").length,
      alertFree: scores.filter((score) => score.verdict === "alert-free").length,
      falseAlerts: scores.filter((score) => score.verdict === "false-alert" || score.verdict === "unexpected-alert").length,
      unknown: scores.filter((score) => score.unknown).length,
      unobserved: scores.filter((score) => score.unobserved).length,
    },
    result: {
      gateDecision: allCriteriaPassed ? "passed" : "failed",
      allCriteriaPassed,
      corpusUnchanged: true,
      fieldTreeUnchanged: fieldUnchanged,
      thresholdMutationDetected: false,
      productionReady: false,
    },
    deterministicResultHash: sha256CanonicalV5(deterministicPayload),
    limitations: [
      "The runner cryptographically verifies the externally witnessed corpus commitments; software alone cannot prove that source or truth attestations describe physical reality.",
      "A V5 decision relies on independent acquisition, truth, detector, and pinned external-witness custody outside this software.",
      "V5 does not qualify the installed receiver, antenna, cable, filter, LNA, gain chain, site, scheduler timing, or navigation integrity.",
      "Normalized spectrum cannot identify spoofing, deliberate jamming, intent, absolute dBm, or navigation error.",
      "Events not observed by the one-tuner schedule are reported separately from detector misses; unknown data is never scored alert-free.",
    ],
  };
}

async function writeExclusive(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o440);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function writeV5ReplayBundle(outputRootPath: string, report: V5ReplayReport): Promise<string> {
  assertSafeId(report.runId, "V5 report runId");
  if (report.sessions.length > MAX_SESSIONS || report.criteria.length > V5_REPLAY_FAMILIES.length * 4) throw new Error("V5 report exceeds its record-count bound");
  const outputRoot = await canonicalPotentialDirectory(outputRootPath, "V5 output root");
  await mkdir(outputRoot, { recursive: true, mode: 0o750 });
  const canonicalOutput = await canonicalDirectory(outputRoot, "V5 output root");
  const bundlePath = path.join(canonicalOutput, report.runId);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!reportBytes.byteLength || reportBytes.byteLength > MAX_REPORT_BYTES) throw new Error("V5 report exceeds its byte bound");
  const manifest = {
    schemaVersion: 1,
    recordType: "rf-monitor-v5-held-out-replay-bundle",
    gate: "V5",
    runId: report.runId,
    corpusId: report.corpus.corpusId,
    release: report.release,
    gateDecision: report.result.gateDecision,
    productionReady: false,
    files: [{ path: "report.json", bytes: reportBytes.byteLength, sha256: sha256Bytes(reportBytes) }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (manifestBytes.byteLength > MAX_BUNDLE_MANIFEST_BYTES) throw new Error("V5 bundle manifest exceeds its byte bound");
  const sums = Buffer.from(`${sha256Bytes(manifestBytes)}  manifest.json\n${sha256Bytes(reportBytes)}  report.json\n`, "utf8");
  const lockPath = path.join(canonicalOutput, `.${report.runId}.publish.lock`);
  const partialPath = path.join(canonicalOutput, `.${report.runId}.${randomUUID()}.partial`);
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let published = false;
  try {
    try {
      await lstat(bundlePath);
      throw new Error(`V5 result bundle already exists: ${report.runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(partialPath, { mode: 0o750 });
    await writeExclusive(path.join(partialPath, "report.json"), reportBytes);
    await writeExclusive(path.join(partialPath, "manifest.json"), manifestBytes);
    await writeExclusive(path.join(partialPath, "SHA256SUMS"), sums);
    const partialDirectory = await open(partialPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await partialDirectory.sync(); } finally { await partialDirectory.close(); }
    // The exclusive publish lock serializes this final-name check and rename
    // for all framework writers. Existing output is never replaced.
    try {
      await lstat(bundlePath);
      throw new Error(`V5 result bundle already exists: ${report.runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(partialPath, bundlePath);
    published = true;
    const outputDirectory = await open(canonicalOutput, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await outputDirectory.sync(); } finally { await outputDirectory.close(); }
    return bundlePath;
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!published) await rm(partialPath, { recursive: true, force: true });
  }
}

export interface V5ReplayBundleVerification {
  outcome: "PASS";
  runId: string;
  gateDecision: "passed" | "failed";
  deterministicResultHash: string;
  witnessKeySha256: string;
  filesVerified: 2;
  bytesVerified: number;
}

export interface V5ReplayBundleReverification extends V5ReplayBundleVerification {
  replayRecomputed: true;
  corpusTreeSha256: string;
}

export async function verifyV5ReplayBundle(bundleRootPath: string, witnessContext: V5WitnessContext): Promise<V5ReplayBundleVerification> {
  const root = await canonicalDirectory(bundleRootPath, "V5 result bundle");
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`V5 bundle contains a non-regular entry: ${entry.name}`);
    return entry.name;
  }).sort();
  if (sha256CanonicalV5(names) !== sha256CanonicalV5(["SHA256SUMS", "manifest.json", "report.json"])) throw new Error("V5 bundle file set is invalid");
  const [manifestBytes, reportBytes, sumsBytes] = await Promise.all([
    readBoundedBuffer(path.join(root, "manifest.json"), MAX_BUNDLE_MANIFEST_BYTES),
    readBoundedBuffer(path.join(root, "report.json"), MAX_REPORT_BYTES),
    readBoundedBuffer(path.join(root, "SHA256SUMS"), 1024),
  ]);
  const expectedSums = `${sha256Bytes(manifestBytes)}  manifest.json\n${sha256Bytes(reportBytes)}  report.json\n`;
  if (sumsBytes.toString("utf8") !== expectedSums) throw new Error("V5 bundle SHA256SUMS mismatch");
  let rawManifest: unknown;
  let rawReport: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    rawReport = JSON.parse(reportBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("V5 bundle JSON is malformed");
  }
  if (!isRecord(rawManifest)
    || rawManifest.schemaVersion !== 1
    || rawManifest.recordType !== "rf-monitor-v5-held-out-replay-bundle"
    || rawManifest.gate !== "V5"
    || rawManifest.productionReady !== false
    || !Array.isArray(rawManifest.files)
    || rawManifest.files.length !== 1) throw new Error("V5 bundle manifest is invalid");
  const listedReport = rawManifest.files[0];
  if (!isRecord(listedReport) || listedReport.path !== "report.json" || listedReport.bytes !== reportBytes.byteLength || listedReport.sha256 !== sha256Bytes(reportBytes)) {
    throw new Error("V5 bundle report is not hash-bound by its manifest");
  }
  if (!isRecord(rawReport)
    || rawReport.schemaVersion !== V5_REPLAY_SCHEMA_VERSION
    || rawReport.recordType !== "rf-monitor-v5-held-out-replay-result"
    || rawReport.frameworkVersion !== V5_REPLAY_FRAMEWORK_VERSION
    || rawReport.gate !== "V5"
    || !isRecord(rawReport.release)
    || !isRecord(rawReport.corpus)
    || !isRecord(rawReport.externalWitness)
    || !isRecord(rawReport.isolation)
    || !isRecord(rawReport.result)
    || !isRecord(rawReport.counts)
    || !Array.isArray(rawReport.sessions)
    || !Array.isArray(rawReport.criteria)) throw new Error("V5 replay report is invalid");
  const report = rawReport as unknown as V5ReplayReport;
  assertSafeId(report.runId, "V5 bundle runId");
  assertIso(report.generatedAt, "V5 bundle generatedAt");
  assertSha256(report.deterministicResultHash, "V5 deterministicResultHash");
  assertSafeId(report.externalWitness.receiptId, "V5 bundle witness receiptId");
  assertSha256(report.externalWitness.keySha256, "V5 bundle witness keySha256");
  assertIso(report.externalWitness.precommitmentCommittedAt, "V5 bundle precommitmentCommittedAt");
  assertIso(report.externalWitness.signedAt, "V5 bundle witness signedAt");
  assertIso(report.externalWitness.unblindingNotBefore, "V5 bundle witness unblindingNotBefore");
  assertSha256(report.externalWitness.statementSha256, "V5 bundle witness statementSha256");
  if (typeof report.externalWitness.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]{80,128}={0,2}$/.test(report.externalWitness.signatureBase64)) {
    throw new Error("V5 bundle witness signature is invalid");
  }
  if (rawManifest.runId !== report.runId || rawManifest.corpusId !== report.corpus.corpusId
    || sha256CanonicalV5(rawManifest.release) !== sha256CanonicalV5(report.release)
    || rawManifest.gateDecision !== report.result.gateDecision) throw new Error("V5 bundle manifest/report identity mismatch");
  const { key, keySha256 } = witnessPublicKey(witnessContext);
  if (report.externalWitness.keySha256 !== keySha256 || report.externalWitness.signatureAlgorithm !== "ed25519" || report.externalWitness.signatureVerified !== true) {
    throw new Error("V5 bundle external witness identity is invalid");
  }
  const statement = createV5WitnessStatement({
    corpusId: report.corpus.corpusId,
    precommitmentSha256: report.corpus.precommitmentSha256,
    precommitmentCommittedAt: report.externalWitness.precommitmentCommittedAt,
    signedAt: report.externalWitness.signedAt,
    unblindingNotBefore: report.externalWitness.unblindingNotBefore,
  });
  if (sha256CanonicalV5(statement) !== report.externalWitness.statementSha256
    || !verifySignature(null, v5WitnessMessage(statement), key, Buffer.from(report.externalWitness.signatureBase64, "base64"))) {
    throw new Error("V5 bundle external witness signature verification failed");
  }
  const allCriteriaPassed = report.criteria.every((criterion) => criterion.passed);
  if (report.sessions.length > MAX_SESSIONS || report.criteria.length !== V5_REPLAY_FAMILIES.length * 4
    || report.result.allCriteriaPassed !== allCriteriaPassed
    || report.result.gateDecision !== (allCriteriaPassed ? "passed" : "failed")
    || report.result.productionReady !== false
    || report.result.thresholdMutationDetected !== false
    || report.result.corpusUnchanged !== true
    || report.result.fieldTreeUnchanged !== true
    || report.isolation.unchanged !== true
    || report.sessions.some((session) => !session.truthVerified)) throw new Error("V5 bundle decision/count/isolation state is inconsistent");
  const counts = {
    sessions: report.sessions.length,
    detected: report.sessions.filter((score) => score.verdict === "detected").length,
    missed: report.sessions.filter((score) => score.verdict === "missed").length,
    alertFree: report.sessions.filter((score) => score.verdict === "alert-free").length,
    falseAlerts: report.sessions.filter((score) => score.verdict === "false-alert" || score.verdict === "unexpected-alert").length,
    unknown: report.sessions.filter((score) => score.unknown).length,
    unobserved: report.sessions.filter((score) => score.unobserved).length,
  };
  if (sha256CanonicalV5(counts) !== sha256CanonicalV5(report.counts)) throw new Error("V5 bundle aggregate counts are inconsistent");
  const deterministicPayload = {
    frameworkVersion: report.frameworkVersion,
    release: report.release,
    corpus: {
      corpusId: report.corpus.corpusId,
      manifestSha256: report.corpus.manifestSha256,
      treeSha256: report.corpus.treeSha256,
      precommitmentSha256: report.corpus.precommitmentSha256,
    },
    externalWitness: {
      receiptId: report.externalWitness.receiptId,
      keySha256: report.externalWitness.keySha256,
      precommitmentCommittedAt: report.externalWitness.precommitmentCommittedAt,
      signedAt: report.externalWitness.signedAt,
      unblindingNotBefore: report.externalWitness.unblindingNotBefore,
      statementSha256: report.externalWitness.statementSha256,
      signatureAlgorithm: report.externalWitness.signatureAlgorithm,
      signatureBase64: report.externalWitness.signatureBase64,
    },
    sessions: report.sessions,
    criteria: report.criteria,
    fieldTree: {
      before: deterministicProtectedTree(report.isolation.before),
      after: deterministicProtectedTree(report.isolation.after),
    },
  };
  if (sha256CanonicalV5(deterministicPayload) !== report.deterministicResultHash) throw new Error("V5 bundle deterministic result hash mismatch");
  return {
    outcome: "PASS",
    runId: report.runId,
    gateDecision: report.result.gateDecision,
    deterministicResultHash: report.deterministicResultHash,
    witnessKeySha256: keySha256,
    filesVerified: 2,
    bytesVerified: manifestBytes.byteLength + reportBytes.byteLength,
  };
}

/**
 * Independently recompute the replay from the sealed corpus. The lightweight
 * bundle verifier above proves file integrity and internal consistency; this
 * stronger verifier also proves that the recorded scores are the output of
 * the frozen detector over the supplied corpus and candidate.
 */
export async function verifyV5ReplayBundleAgainstCorpus(
  bundleRootPath: string,
  options: V5ReplayOptions,
): Promise<V5ReplayBundleReverification> {
  const [bundleRoot, corpusRoot, protectedRoot] = await Promise.all([
    canonicalDirectory(bundleRootPath, "V5 result bundle"),
    canonicalDirectory(options.corpusRoot, "V5 corpus root"),
    canonicalPotentialDirectory(options.protectedFieldRoot, "Protected field root"),
  ]);
  if (pathsOverlap(bundleRoot, corpusRoot) || pathsOverlap(bundleRoot, protectedRoot)) {
    throw new Error("V5 result bundle must be outside the corpus and protected field roots");
  }
  const integrity = await verifyV5ReplayBundle(bundleRoot, options.witness);
  const reportBytes = await readBoundedBuffer(path.join(bundleRoot, "report.json"), MAX_REPORT_BYTES);
  let recorded: V5ReplayReport;
  try {
    recorded = JSON.parse(reportBytes.toString("utf8")) as V5ReplayReport;
  } catch {
    throw new Error("V5 result report is not valid JSON");
  }
  const recomputed = await runV5HeldOutReplay({
    ...options,
    corpusRoot,
    protectedFieldRoot: protectedRoot,
    runId: recorded.runId,
    now: () => new Date(recorded.generatedAt),
  });
  const recordedProjection = {
    release: recorded.release,
    corpus: recorded.corpus,
    sessions: recorded.sessions,
    criteria: recorded.criteria,
    counts: recorded.counts,
    result: recorded.result,
    deterministicResultHash: recorded.deterministicResultHash,
  };
  const recomputedProjection = {
    release: recomputed.release,
    corpus: recomputed.corpus,
    sessions: recomputed.sessions,
    criteria: recomputed.criteria,
    counts: recomputed.counts,
    result: recomputed.result,
    deterministicResultHash: recomputed.deterministicResultHash,
  };
  if (sha256CanonicalV5(recordedProjection) !== sha256CanonicalV5(recomputedProjection)) {
    throw new Error("V5 bundle scores do not match an independent replay of the sealed corpus");
  }
  return {
    ...integrity,
    replayRecomputed: true,
    corpusTreeSha256: recomputed.corpus.treeSha256,
  };
}

export function supportedV5ReceiverModel(value: unknown): SupportedReceiverModel | undefined {
  return parseSupportedReceiverModel(value);
}
