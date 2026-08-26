import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { detectorQualificationPlan } from "../shared/detectorQualification";
import {
  MAX_ANALYSIS_SPAN_HZ,
  parseSupportedReceiverModel,
  PRODUCTION_SAMPLE_RATE_HZ,
  type SupportedReceiverModel,
} from "../shared/productContract";
import type { BandCatalog } from "../shared/types";
import type { FrozenCandidateIdentity } from "./syntheticQualificationCampaign";

export const V6_CONDUCTED_SCHEMA_VERSION = 1 as const;
export const V6_CONDUCTED_FRAMEWORK_VERSION = "rf-v6-installed-chain-1.0.0" as const;
export const V6_INDEPENDENT_RUNS_PER_TARGET_CASE = 10 as const;

export const V6_CASE_KINDS = [
  "target-range",
  "frequency-accuracy",
  "wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
  "guard-only",
  "sham",
] as const;
export type V6CaseKind = typeof V6_CASE_KINDS[number];

export const V6_PREREQUISITE_GATES = ["V0", "V1", "V2", "V3", "V4", "V5"] as const;
export type V6PrerequisiteGate = typeof V6_PREREQUISITE_GATES[number];

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const MAX_CAMPAIGN_FILES = 5_000;
const MAX_CAMPAIGN_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_FFT_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 32 * 1024 * 1024;
const MAX_PREREQUISITE_BYTES = 64 * 1024 * 1024;
const MAX_WITNESS_KEY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const CAMPAIGN_MANIFEST_FILE = "campaign-manifest.json";

export interface V6ApprovedTargetBinding {
  targetId: string;
  centerHz: number;
  captureSpanHz: number;
  analysisSpanHz: number;
  analysisMaskSha256: string;
  baselineId: string;
  baselineDescriptorSha256: string;
  baselineFingerprintSha256: string;
}

export interface V6ApprovedBinding {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-approved-binding";
  approvedAt: string;
  release: FrozenCandidateIdentity;
  configuration: {
    configurationSha256: string;
    catalogVersion: string;
    catalogSha256: string;
  };
  site: { bindingSha256: string };
  receiver: { model: SupportedReceiverModel; serialSha256: string };
  installedChain: {
    fingerprintSha256: string;
    injectionReferencePlaneSha256: string;
    componentSha256: {
      antenna: string;
      cable: string;
      filter: string | null;
      lna: string | null;
      attenuator: string;
      surgeProtection: string | null;
    };
  };
  rf: {
    sdrconnectVersion: string;
    fixedGainProfileSha256: string;
    sampleRateHz: 10_000_000;
    inputBinCount: number;
    analysisStartBin: number;
    analysisEndBin: number;
    spectrumReference: number;
    spectrumBase: number;
    normalizedEncoding: "uint8-display-values";
    iq: false;
  };
  targets: V6ApprovedTargetBinding[];
  baselineSetSha256: string;
}

export interface V6PrerequisiteReference {
  gate: V6PrerequisiteGate;
  decision: "passed";
  completedAt: string;
  artifactPath: string;
  artifactSha256: string;
  release: FrozenCandidateIdentity;
  configurationSha256: string;
}

export const V6_PREREQUISITE_SOURCE_ROLES = {
  V0: ["traceability-report"],
  V1: ["validation-record"],
  V2: ["qualification-record"],
  V3: ["browser-result"],
  V4: ["packaged-result", "detector-result", "combined-result"],
  V5: ["bundle-manifest", "replay-result", "verification-record"],
} as const;

export type V6PrerequisiteSourceRole = typeof V6_PREREQUISITE_SOURCE_ROLES[V6PrerequisiteGate][number];

export interface V6PrerequisiteSourceReference {
  role: V6PrerequisiteSourceRole;
  artifactPath: string;
  artifactSha256: string;
}

export interface V6PrerequisiteWrapper {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-prerequisite-wrapper";
  gate: V6PrerequisiteGate;
  decision: "passed";
  completedAt: string;
  release: FrozenCandidateIdentity;
  configurationSha256: string;
  sources: V6PrerequisiteSourceReference[];
  sourceSetSha256: string;
}

export type V6EquipmentRole = "signal-generator" | "frequency-power-reference" | "attenuation-path";

export interface V6EquipmentRecord {
  equipmentId: string;
  role: V6EquipmentRole;
  modelSha256: string;
  serialSha256: string;
  certificatePath: string;
  certificateSha256: string;
  certificateIdSha256: string;
  calibrated: true;
  calibrationValidFrom: string;
  calibrationValidUntil: string;
  statedUncertainty: string;
}

export type V6ExpectedOutcome = "metadata-match" | "alert" | "overload" | "no-alert";
export type V6ObservedOutcome = V6ExpectedOutcome | "unknown";

export interface V6MatrixCase {
  caseId: string;
  targetId: string;
  kind: V6CaseKind;
  independentRun: number;
  acquisitionDescriptorPath: string;
  rawTablePath: string;
  evidencePath: string;
  expected: {
    outcome: V6ExpectedOutcome;
    stimulusEnabled: boolean;
    generatorFrequencyHz: number | null;
    sourceLevelDbmAtGeneratorPort: { minimum: number; maximum: number } | null;
    occupiedWidthHz: { minimum: number; maximum: number } | null;
    maximumAbsoluteFrequencyErrorHz: number | null;
  };
}

export interface V6ConductedProtocol {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-conducted-protocol";
  frameworkVersion: typeof V6_CONDUCTED_FRAMEWORK_VERSION;
  campaignId: string;
  committedAt: string;
  approvedBindingSha256: string;
  binding: V6ApprovedBinding;
  identities: {
    implementerIdentitySha256: string;
    custodyIdentitySha256: string;
    witnessIdentitySha256: string;
  };
  v5ReplayVerification: {
    verifierIdentitySha256: string;
    verifierKeySha256: string;
  };
  method: {
    dataDomain: "test";
    coupling: "conducted-shielded";
    radiated: false;
    iq: false;
    input: "real-rspdx-normalized-uint8";
  };
  prerequisites: V6PrerequisiteReference[];
  equipment: V6EquipmentRecord[];
  matrix: V6MatrixCase[];
  acceptance: {
    independentRunsPerTargetCase: 10;
    unknownCanPass: false;
    guardOrShamAlertAllowed: false;
    overloadMustBeSeparate: true;
  };
}

export interface V6AcquisitionDescriptor {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-conducted-acquisition";
  campaignId: string;
  caseId: string;
  acquisitionId: string;
  firstExposureAt: string;
  lastExposureAt: string;
  source: {
    receiverModel: SupportedReceiverModel;
    receiverSerialSha256: string;
    installedChainFingerprintSha256: string;
    sdrconnectVersion: string;
    fixedGainProfileSha256: string;
    sampleRateHz: 10_000_000;
    normalizedEncoding: "uint8-display-values";
    realReceiver: true;
    synthetic: false;
    simulation: false;
    replay: false;
    iq: false;
    dataDomain: "test";
    coupling: "conducted-shielded";
    radiated: false;
  };
  target: {
    targetId: string;
    centerHz: number;
    captureSpanHz: number;
    analysisSpanHz: number;
    analysisMaskSha256: string;
    baselineId: string;
    baselineDescriptorSha256: string;
    baselineFingerprintSha256: string;
  };
  fft: {
    path: string;
    rows: number;
    inputBinCount: number;
    bytes: number;
  };
}

export interface V6RawMeasurementTable {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-raw-measurement";
  campaignId: string;
  caseId: string;
  acquisitionId: string;
  targetId: string;
  kind: V6CaseKind;
  dataDomain: "test";
  coupling: "conducted-shielded";
  radiated: false;
  iq: false;
  stimulus: {
    enabled: boolean;
    generatorFrequencyHz: number | null;
    sourceLevelDbmAtGeneratorPort: number | null;
    occupiedWidthHz: number | null;
  };
  observation: {
    outcome: V6ObservedOutcome;
    attributedTargetId: string | null;
    confirmedCenterHz: number;
    confirmedSampleRateHz: number;
    captureStartHz: number;
    captureEndHz: number;
    analysisStartHz: number;
    analysisEndHz: number;
    observedPeakHz: number | null;
    alertKinds: Array<"wideband-rise" | "narrowband-spike" | "slow-drift" | "overload">;
    overloadObserved: boolean;
    acceptedFrames: number;
    invalidOrStaleFrames: number;
  };
  uncertainty: {
    frequencyHz: number;
    sourceLevelDb: number;
  };
}

export interface V6DeclaredResult {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-declared-result";
  campaignId: string;
  protocolSha256: string;
  completedAt: string;
  expectedCases: number;
  caseResultSha256: string;
  decision: "passed" | "failed";
}

export interface V6CampaignFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface V6ProtocolWitnessStatement {
  schemaVersion: 1;
  purpose: "rf-monitor-v6-protocol-witness";
  campaignId: string;
  protocolSha256: string;
  approvedBindingSha256: string;
  protocolCommittedAt: string;
  signedAt: string;
  firstExposureNotBefore: string;
  implementerIdentitySha256: string;
  custodyIdentitySha256: string;
  witnessIdentitySha256: string;
}

export interface V6FinalWitnessStatement {
  schemaVersion: 1;
  purpose: "rf-monitor-v6-final-campaign-witness";
  campaignId: string;
  protocolSha256: string;
  evidenceTreeSha256: string;
  declaredResultSha256: string;
  caseResultSha256: string;
  declaredDecision: "passed" | "failed";
  firstExposureAt: string;
  lastExposureAt: string;
  signedAt: string;
  implementerIdentitySha256: string;
  custodyIdentitySha256: string;
  witnessIdentitySha256: string;
}

export interface V5IndependentVerificationStatement {
  schemaVersion: 1;
  purpose: "rf-monitor-v5-independent-replay-verification";
  gate: "V5";
  outcome: "PASS";
  verifiedAt: string;
  release: FrozenCandidateIdentity;
  configurationSha256: string;
  bundleManifestSha256: string;
  reportSha256: string;
  v5WitnessKeySha256: string;
  verifierIdentitySha256: string;
}

interface V6WitnessEnvelope<T> {
  receiptId: string;
  statement: T;
  statementSha256: string;
  keySha256: string;
  signatureAlgorithm: "ed25519";
  signatureBase64: string;
}

export interface V6CampaignManifest {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-conducted-campaign";
  frameworkVersion: typeof V6_CONDUCTED_FRAMEWORK_VERSION;
  campaignId: string;
  createdAt: string;
  protocol: { path: string; sha256: string };
  declaredResult: { path: string; sha256: string };
  files: V6CampaignFileEntry[];
  evidenceTreeSha256: string;
  protocolWitness: V6WitnessEnvelope<V6ProtocolWitnessStatement>;
  finalWitness: V6WitnessEnvelope<V6FinalWitnessStatement>;
}

export interface V6CandidateContext {
  release: FrozenCandidateIdentity;
  catalog: BandCatalog;
  configurationSha256: string;
  catalogSha256: string;
}

export interface V6WitnessContext {
  publicKeyPem: string | Uint8Array;
  expectedKeySha256: string;
}

export interface V6RunOptions {
  campaignRoot: string;
  candidate: V6CandidateContext;
  approvedBinding: V6ApprovedBinding;
  approvedBindingSha256: string;
  witness: V6WitnessContext;
  now?: () => Date;
  runId?: string;
}

export interface V6CaseScore {
  caseId: string;
  targetId: string;
  kind: V6CaseKind;
  independentRun: number;
  observedOutcome: V6ObservedOutcome;
  passed: boolean;
  failureReasons: string[];
  measured: {
    generatorFrequencyHz: number | null;
    sourceLevelDbmAtGeneratorPort: number | null;
    occupiedWidthHz: number | null;
    observedPeakHz: number | null;
    absoluteFrequencyErrorHz: number | null;
    frequencyUncertaintyHz: number;
    sourceLevelUncertaintyDb: number;
  };
}

export interface V6ConductedReport {
  schemaVersion: 1;
  recordType: "rf-monitor-v6-conducted-result";
  frameworkVersion: typeof V6_CONDUCTED_FRAMEWORK_VERSION;
  gate: "V6";
  generatedAt: string;
  runId: string;
  campaignId: string;
  release: FrozenCandidateIdentity;
  approvedBindingSha256: string;
  binding: V6ApprovedBinding;
  campaign: {
    manifestSha256: string;
    protocolSha256: string;
    declaredResultSha256: string;
    evidenceTreeSha256: string;
    files: number;
    bytes: number;
    firstExposureAt: string;
    lastExposureAt: string;
  };
  witness: {
    keySha256: string;
    protocol: V6WitnessEnvelope<V6ProtocolWitnessStatement> & { verified: true };
    final: V6WitnessEnvelope<V6FinalWitnessStatement> & { verified: true };
    custodyStatementOnly: true;
  };
  cases: V6CaseScore[];
  byTargetKind: Array<{
    targetId: string;
    kind: V6CaseKind;
    runs: number;
    passed: number;
    failed: number;
  }>;
  testedEnvelope: Array<{
    targetId: string;
    kind: V6CaseKind;
    sourceLevelDbmAtGeneratorPort: { minimum: number; maximum: number } | null;
    generatorFrequencyHz: { minimum: number; maximum: number } | null;
    occupiedWidthHz: { minimum: number; maximum: number } | null;
    maximumFrequencyErrorHz: number | null;
    maximumFrequencyUncertaintyHz: number;
    maximumSourceLevelUncertaintyDb: number;
  }>;
  counts: { cases: number; passed: number; failed: number; unknown: number };
  result: {
    gateDecision: "passed" | "failed";
    completeMatrix: true;
    prerequisiteGatesPassed: true;
    calibratedEquipmentInDate: true;
    fieldDataWritten: false;
    productionReady: false;
  };
  deterministicResultHash: string;
  limitations: string[];
}

export interface V6BundleVerification {
  outcome: "PASS";
  gateDecision: "passed" | "failed";
  campaignId: string;
  reportSha256: string;
  witnessKeySha256: string;
}

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

export function sha256CanonicalV6(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function assertFinite(value: unknown, label: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its bound`);
}

function assertInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is outside its integer bound`);
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} is not a safe relative path`);
  }
  return value;
}

function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} has unsupported or missing fields`);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return sha256CanonicalV6(left) === sha256CanonicalV6(right);
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`V6 campaign path escapes its root: ${relativePath}`);
  return resolved;
}

async function canonicalDirectory(directoryPath: string, label: string, readOnly: boolean): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (readOnly && (details.mode & 0o222) !== 0) throw new Error(`${label} must be read-only`);
  const canonicalPath = await realpath(resolved);
  if (canonicalPath !== resolved) throw new Error(`${label} may not contain symlinked path components`);
  return canonicalPath;
}

async function canonicalPotentialDirectory(directoryPath: string, label: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const details = await lstat(cursor);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} existing ancestor must be a real directory`);
      const canonicalPath = await realpath(cursor);
      if (canonicalPath !== cursor) throw new Error(`${label} may not contain symlinked path components`);
      return path.join(canonicalPath, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`${label} has no safe existing ancestor`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function openRegularNoFollow(filePath: string, maximumBytes: number, requireReadOnly: boolean): Promise<{ handle: FileHandle; bytes: number }> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) throw new Error(`V6 file size/type bound failed: ${path.basename(filePath)}`);
    if (requireReadOnly && (details.mode & 0o222) !== 0) throw new Error(`V6 campaign file must be read-only: ${path.basename(filePath)}`);
    return { handle, bytes: details.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBounded(filePath: string, maximumBytes: number, requireReadOnly = true): Promise<Buffer> {
  const { handle, bytes } = await openRegularNoFollow(filePath, maximumBytes, requireReadOnly);
  try {
    const result = Buffer.allocUnsafe(bytes);
    const read = await handle.read(result, 0, result.byteLength, 0);
    if (read.bytesRead !== result.byteLength) throw new Error(`V6 file changed while reading: ${path.basename(filePath)}`);
    return result;
  } finally {
    await handle.close();
  }
}

async function readJson<T>(filePath: string, maximumBytes = MAX_JSON_BYTES, requireReadOnly = true): Promise<{ value: T; bytes: Buffer; sha256: string }> {
  const bytes = await readBounded(filePath, maximumBytes, requireReadOnly);
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as T, bytes, sha256: sha256Bytes(bytes) };
  } catch {
    throw new Error(`V6 JSON is invalid: ${path.basename(filePath)}`);
  }
}

async function hashFile(filePath: string, maximumBytes: number, requireReadOnly = true): Promise<{ sha256: string; bytes: number }> {
  const { handle, bytes } = await openRegularNoFollow(filePath, maximumBytes, requireReadOnly);
  const hash = createHash("sha256");
  try {
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

function maximumForPath(relativePath: string): number {
  if (relativePath.endsWith(".uint8")) return MAX_FFT_BYTES;
  if (/certificate|calibration/i.test(relativePath)) return MAX_CERTIFICATE_BYTES;
  if (/prerequisite/i.test(relativePath)) return MAX_PREREQUISITE_BYTES;
  if (/evidence/i.test(relativePath)) return MAX_EVIDENCE_FILE_BYTES;
  return MAX_JSON_BYTES;
}

async function listTree(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];
  let entries = 0;
  while (queue.length) {
    const relativeDirectory = queue.shift()!;
    const absoluteDirectory = relativeDirectory ? resolveInside(root, relativeDirectory) : root;
    const directory = await lstat(absoluteDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o222) !== 0) throw new Error("V6 campaign tree must contain only read-only real directories and files");
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_CAMPAIGN_FILES + 64) throw new Error("V6 campaign tree exceeds its entry bound");
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isSymbolicLink()) throw new Error(`V6 campaign tree contains a symlink: ${relative}`);
      if (child.isDirectory()) queue.push(relative);
      else if (child.isFile()) files.push(relative);
      else throw new Error(`V6 campaign tree contains an unsupported entry: ${relative}`);
    }
  }
  return files.sort();
}

export function v6InstalledChainFingerprint(binding: Pick<V6ApprovedBinding, "receiver" | "installedChain" | "rf">): string {
  return sha256CanonicalV6({
    receiver: binding.receiver,
    injectionReferencePlaneSha256: binding.installedChain.injectionReferencePlaneSha256,
    componentSha256: binding.installedChain.componentSha256,
    sdrconnectVersion: binding.rf.sdrconnectVersion,
    fixedGainProfileSha256: binding.rf.fixedGainProfileSha256,
  });
}

export function v6BaselineSetFingerprint(targets: V6ApprovedTargetBinding[]): string {
  return sha256CanonicalV6([...targets]
    .sort((left, right) => left.targetId.localeCompare(right.targetId))
    .map(({ targetId, baselineId, baselineDescriptorSha256, baselineFingerprintSha256, analysisMaskSha256 }) => ({
      targetId,
      baselineId,
      baselineDescriptorSha256,
      baselineFingerprintSha256,
      analysisMaskSha256,
    })));
}

function validateRelease(value: FrozenCandidateIdentity, label: string): void {
  exactKeys(value, ["schemaVersion", "product", "releaseVersion", "buildId", "sourceDigest", "packageDigest", "dependencyLockDigest"], label);
  if (value.schemaVersion !== 1 || value.product !== "rf-monitor") throw new Error(`${label} is not an RF Monitor frozen candidate`);
  if (typeof value.buildId !== "string" || !RELEASE_ID_PATTERN.test(value.buildId)) throw new Error(`${label} build id is invalid`);
  for (const [key, digest] of Object.entries({ sourceDigest: value.sourceDigest, packageDigest: value.packageDigest, dependencyLockDigest: value.dependencyLockDigest })) assertHash(digest, `${label} ${key}`);
}

export function validateV6ApprovedBinding(binding: V6ApprovedBinding, candidate: V6CandidateContext): void {
  exactKeys(binding, ["schemaVersion", "recordType", "approvedAt", "release", "configuration", "site", "receiver", "installedChain", "rf", "targets", "baselineSetSha256"], "V6 approved binding");
  if (binding.schemaVersion !== 1 || binding.recordType !== "rf-monitor-v6-approved-binding") throw new Error("V6 approved binding schema is invalid");
  assertIso(binding.approvedAt, "V6 binding approval time");
  exactKeys(binding.configuration, ["configurationSha256", "catalogVersion", "catalogSha256"], "V6 binding configuration");
  exactKeys(binding.site, ["bindingSha256"], "V6 binding site");
  exactKeys(binding.receiver, ["model", "serialSha256"], "V6 binding receiver");
  exactKeys(binding.installedChain, ["fingerprintSha256", "injectionReferencePlaneSha256", "componentSha256"], "V6 installed chain");
  exactKeys(binding.installedChain.componentSha256, ["antenna", "cable", "filter", "lna", "attenuator", "surgeProtection"], "V6 installed-chain components");
  exactKeys(binding.rf, ["sdrconnectVersion", "fixedGainProfileSha256", "sampleRateHz", "inputBinCount", "analysisStartBin", "analysisEndBin", "spectrumReference", "spectrumBase", "normalizedEncoding", "iq"], "V6 RF binding");
  validateRelease(binding.release, "V6 approved release");
  if (!sameCanonical(binding.release, candidate.release)) throw new Error("V6 approved binding is stale for the frozen candidate");
  assertHash(binding.configuration.configurationSha256, "V6 configuration hash");
  assertHash(binding.configuration.catalogSha256, "V6 catalog hash");
  if (binding.configuration.configurationSha256 !== candidate.configurationSha256
    || binding.configuration.catalogSha256 !== candidate.catalogSha256
    || binding.configuration.catalogVersion !== candidate.catalog.catalogVersion) throw new Error("V6 approved binding configuration or catalog is stale");
  assertHash(binding.site.bindingSha256, "V6 site binding hash");
  const model = parseSupportedReceiverModel(binding.receiver.model);
  if (!model || model !== binding.receiver.model) throw new Error("V6 requires exactly one RSPdx or RSPdx R2 receiver model");
  assertHash(binding.receiver.serialSha256, "V6 receiver serial hash");
  assertHash(binding.installedChain.fingerprintSha256, "V6 installed-chain fingerprint");
  assertHash(binding.installedChain.injectionReferencePlaneSha256, "V6 injection reference-plane hash");
  for (const [name, digest] of Object.entries(binding.installedChain.componentSha256)) if (digest !== null) assertHash(digest, `V6 chain component ${name}`);
  if (binding.installedChain.fingerprintSha256 !== v6InstalledChainFingerprint(binding)) throw new Error("V6 installed-chain fingerprint is not reproducible from the approved binding");
  if (!binding.rf.sdrconnectVersion || binding.rf.sdrconnectVersion.length > 128) throw new Error("V6 SDRconnect version is missing or too long");
  assertHash(binding.rf.fixedGainProfileSha256, "V6 fixed-gain profile hash");
  if (binding.rf.sampleRateHz !== PRODUCTION_SAMPLE_RATE_HZ || binding.rf.iq !== false || binding.rf.normalizedEncoding !== "uint8-display-values") throw new Error("V6 RF binding must use confirmed 10 MS/s normalized uint8 with IQ off");
  assertInteger(binding.rf.inputBinCount, "V6 input bins", 8, 65_536);
  assertInteger(binding.rf.analysisStartBin, "V6 analysis start bin", 0, binding.rf.inputBinCount - 1);
  assertInteger(binding.rf.analysisEndBin, "V6 analysis end bin", binding.rf.analysisStartBin + 1, binding.rf.inputBinCount);
  assertFinite(binding.rf.spectrumReference, "V6 spectrum reference");
  assertFinite(binding.rf.spectrumBase, "V6 spectrum base");
  const planTargets = detectorQualificationPlan(candidate.catalog).targets;
  if (!Array.isArray(binding.targets) || binding.targets.length !== planTargets.length) throw new Error("V6 binding must contain all four Tier-1 targets exactly once");
  const seen = new Set<string>();
  for (const target of binding.targets) {
    exactKeys(target, ["targetId", "centerHz", "captureSpanHz", "analysisSpanHz", "analysisMaskSha256", "baselineId", "baselineDescriptorSha256", "baselineFingerprintSha256"], "V6 target binding");
    if (seen.has(target.targetId)) throw new Error("V6 binding contains a duplicate Tier-1 target");
    seen.add(target.targetId);
    const expected = planTargets.find((entry) => entry.id === target.targetId);
    if (!expected || target.centerHz !== expected.centerHz || target.captureSpanHz !== expected.captureSpanHz || target.analysisSpanHz !== expected.analysisSpanHz) throw new Error(`V6 target binding is stale or outside the catalog: ${target.targetId}`);
    if (target.analysisSpanHz <= 0 || target.analysisSpanHz > MAX_ANALYSIS_SPAN_HZ || target.analysisSpanHz > target.captureSpanHz) throw new Error(`V6 target analysis span is invalid: ${target.targetId}`);
    assertHash(target.analysisMaskSha256, `V6 ${target.targetId} mask hash`);
    assertSafeId(target.baselineId, `V6 ${target.targetId} baseline id`);
    assertHash(target.baselineDescriptorSha256, `V6 ${target.targetId} baseline descriptor hash`);
    assertHash(target.baselineFingerprintSha256, `V6 ${target.targetId} baseline fingerprint hash`);
  }
  assertHash(binding.baselineSetSha256, "V6 baseline-set hash");
  if (binding.baselineSetSha256 !== v6BaselineSetFingerprint(binding.targets)) throw new Error("V6 baseline-set fingerprint does not match its exact target baselines");
}

function witnessKey(context: V6WitnessContext): { key: KeyObject; keySha256: string } {
  const bytes = typeof context.publicKeyPem === "string" ? Buffer.from(context.publicKeyPem, "utf8") : Buffer.from(context.publicKeyPem);
  if (!bytes.byteLength || bytes.byteLength > MAX_WITNESS_KEY_BYTES) throw new Error("V6 witness public key exceeds its bound");
  assertHash(context.expectedKeySha256, "V6 expected witness key fingerprint");
  let key: KeyObject;
  try { key = createPublicKey(bytes); } catch { throw new Error("V6 witness public key is invalid"); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("V6 witness key must be Ed25519");
  const keySha256 = sha256Bytes(key.export({ type: "spki", format: "der" }));
  if (keySha256 !== context.expectedKeySha256) throw new Error("V6 witness key does not match the out-of-band pinned fingerprint");
  return { key, keySha256 };
}

export function v6WitnessKeyFingerprint(publicKeyPem: string | Uint8Array): string {
  const bytes = typeof publicKeyPem === "string" ? Buffer.from(publicKeyPem, "utf8") : Buffer.from(publicKeyPem);
  if (!bytes.byteLength || bytes.byteLength > MAX_WITNESS_KEY_BYTES) throw new Error("V6 witness public key exceeds its bound");
  const key = createPublicKey(bytes);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("V6 witness key must be Ed25519");
  return sha256Bytes(key.export({ type: "spki", format: "der" }));
}

export function createV6ProtocolWitnessStatement(input: Omit<V6ProtocolWitnessStatement, "schemaVersion" | "purpose">): V6ProtocolWitnessStatement {
  return { schemaVersion: 1, purpose: "rf-monitor-v6-protocol-witness", ...input };
}

export function createV6FinalWitnessStatement(input: Omit<V6FinalWitnessStatement, "schemaVersion" | "purpose">): V6FinalWitnessStatement {
  return { schemaVersion: 1, purpose: "rf-monitor-v6-final-campaign-witness", ...input };
}

export function createV5IndependentVerificationStatement(input: Omit<V5IndependentVerificationStatement, "schemaVersion" | "purpose" | "gate" | "outcome">): V5IndependentVerificationStatement {
  return { schemaVersion: 1, purpose: "rf-monitor-v5-independent-replay-verification", gate: "V5", outcome: "PASS", ...input };
}

export function v6WitnessMessage(statement: V6ProtocolWitnessStatement | V6FinalWitnessStatement): Buffer {
  return Buffer.from(JSON.stringify(canonical(statement)), "utf8");
}

export function v5IndependentVerifierMessage(statement: V5IndependentVerificationStatement): Buffer {
  return Buffer.from(JSON.stringify(canonical(statement)), "utf8");
}

function verifyWitnessEnvelope<T extends V6ProtocolWitnessStatement | V6FinalWitnessStatement>(envelope: V6WitnessEnvelope<T>, expected: T, key: KeyObject, keySha256: string, label: string): void {
  assertSafeId(envelope.receiptId, `${label} receipt`);
  if (!sameCanonical(envelope.statement, expected)) throw new Error(`${label} statement does not match the campaign`);
  assertHash(envelope.statementSha256, `${label} statement hash`);
  if (envelope.statementSha256 !== sha256CanonicalV6(expected)) throw new Error(`${label} statement hash mismatch`);
  if (envelope.keySha256 !== keySha256 || envelope.signatureAlgorithm !== "ed25519") throw new Error(`${label} key or algorithm mismatch`);
  let signature: Buffer;
  try { signature = Buffer.from(envelope.signatureBase64, "base64"); } catch { throw new Error(`${label} signature encoding is invalid`); }
  if (signature.byteLength !== 64 || !verifySignature(null, v6WitnessMessage(expected), key, signature)) throw new Error(`${label} signature verification failed`);
}

function expectedOutcome(kind: V6CaseKind): V6ExpectedOutcome {
  if (kind === "target-range" || kind === "frequency-accuracy") return "metadata-match";
  if (["wideband", "cw", "multitone", "moving-narrowband"].includes(kind)) return "alert";
  if (kind === "overload") return "overload";
  return "no-alert";
}

function validateProtocol(protocol: V6ConductedProtocol, candidate: V6CandidateContext, approvedBinding: V6ApprovedBinding, approvedBindingSha256: string): void {
  exactKeys(protocol, ["schemaVersion", "recordType", "frameworkVersion", "campaignId", "committedAt", "approvedBindingSha256", "binding", "identities", "v5ReplayVerification", "method", "prerequisites", "equipment", "matrix", "acceptance"], "V6 protocol");
  if (protocol.schemaVersion !== 1 || protocol.recordType !== "rf-monitor-v6-conducted-protocol" || protocol.frameworkVersion !== V6_CONDUCTED_FRAMEWORK_VERSION) throw new Error("V6 protocol schema/framework is invalid");
  assertSafeId(protocol.campaignId, "V6 campaign id");
  assertIso(protocol.committedAt, "V6 protocol commitment time");
  if (protocol.approvedBindingSha256 !== approvedBindingSha256 || !sameCanonical(protocol.binding, approvedBinding)) throw new Error("V6 protocol is not bound to the separately approved installed-chain record");
  validateV6ApprovedBinding(protocol.binding, candidate);
  exactKeys(protocol.identities, ["implementerIdentitySha256", "custodyIdentitySha256", "witnessIdentitySha256"], "V6 role identities");
  exactKeys(protocol.v5ReplayVerification, ["verifierIdentitySha256", "verifierKeySha256"], "V6 V5 replay-verifier pin");
  exactKeys(protocol.method, ["dataDomain", "coupling", "radiated", "iq", "input"], "V6 test method");
  exactKeys(protocol.acceptance, ["independentRunsPerTargetCase", "unknownCanPass", "guardOrShamAlertAllowed", "overloadMustBeSeparate"], "V6 acceptance criteria");
  for (const digest of Object.values(protocol.identities)) assertHash(digest, "V6 role identity hash");
  const identities = new Set(Object.values(protocol.identities));
  if (identities.size !== 3) throw new Error("V6 implementer, custody, and independent witness identities must be distinct");
  assertHash(protocol.v5ReplayVerification.verifierIdentitySha256, "V6 V5 verifier identity pin");
  assertHash(protocol.v5ReplayVerification.verifierKeySha256, "V6 V5 verifier key pin");
  if (identities.has(protocol.v5ReplayVerification.verifierIdentitySha256)) throw new Error("V6 V5 replay verifier identity must be distinct from V6 roles");
  if (protocol.method.dataDomain !== "test" || protocol.method.coupling !== "conducted-shielded" || protocol.method.radiated !== false || protocol.method.iq !== false || protocol.method.input !== "real-rspdx-normalized-uint8") throw new Error("V6 permits only isolated test-domain conducted/shielded real normalized-uint8 acquisitions with IQ off");
  if (!Array.isArray(protocol.prerequisites) || protocol.prerequisites.length !== V6_PREREQUISITE_GATES.length) throw new Error("V6 requires exact V0-V5 prerequisite artifacts");
  const prerequisiteGates = new Set<V6PrerequisiteGate>();
  for (const prerequisite of protocol.prerequisites) {
    exactKeys(prerequisite, ["gate", "decision", "completedAt", "artifactPath", "artifactSha256", "release", "configurationSha256"], "V6 prerequisite reference");
    if (!V6_PREREQUISITE_GATES.includes(prerequisite.gate) || prerequisiteGates.has(prerequisite.gate)) throw new Error("V6 prerequisite gates are missing or duplicated");
    prerequisiteGates.add(prerequisite.gate);
    if (prerequisite.decision !== "passed") throw new Error(`V6 prerequisite ${prerequisite.gate} did not pass`);
    assertIso(prerequisite.completedAt, `V6 ${prerequisite.gate} completion`);
    if (Date.parse(prerequisite.completedAt) > Date.parse(protocol.committedAt)) throw new Error(`V6 prerequisite ${prerequisite.gate} completed after protocol commitment`);
    safeRelativePath(prerequisite.artifactPath, `V6 ${prerequisite.gate} artifact`);
    assertHash(prerequisite.artifactSha256, `V6 ${prerequisite.gate} artifact hash`);
    validateRelease(prerequisite.release, `V6 ${prerequisite.gate} release`);
    if (!sameCanonical(prerequisite.release, candidate.release) || prerequisite.configurationSha256 !== candidate.configurationSha256) throw new Error(`V6 prerequisite ${prerequisite.gate} is stale for the candidate/configuration`);
  }
  const requiredRoles = new Set<V6EquipmentRole>(["signal-generator", "frequency-power-reference", "attenuation-path"]);
  if (!Array.isArray(protocol.equipment) || protocol.equipment.length < requiredRoles.size || protocol.equipment.length > 32) throw new Error("V6 calibrated equipment set is incomplete or unbounded");
  const equipmentIds = new Set<string>();
  for (const equipment of protocol.equipment) {
    exactKeys(equipment, ["equipmentId", "role", "modelSha256", "serialSha256", "certificatePath", "certificateSha256", "certificateIdSha256", "calibrated", "calibrationValidFrom", "calibrationValidUntil", "statedUncertainty"], "V6 equipment record");
    assertSafeId(equipment.equipmentId, "V6 equipment id");
    if (equipmentIds.has(equipment.equipmentId)) throw new Error("V6 equipment id is duplicated");
    equipmentIds.add(equipment.equipmentId);
    requiredRoles.delete(equipment.role);
    for (const digest of [equipment.modelSha256, equipment.serialSha256, equipment.certificateSha256, equipment.certificateIdSha256]) assertHash(digest, "V6 equipment identity/certificate hash");
    safeRelativePath(equipment.certificatePath, "V6 calibration certificate path");
    if (equipment.calibrated !== true) throw new Error("V6 equipment must have calibrated=true");
    assertIso(equipment.calibrationValidFrom, "V6 calibration valid-from");
    assertIso(equipment.calibrationValidUntil, "V6 calibration valid-until");
    if (Date.parse(equipment.calibrationValidUntil) <= Date.parse(equipment.calibrationValidFrom) || !equipment.statedUncertainty || equipment.statedUncertainty.length > 256) throw new Error("V6 equipment calibration interval/uncertainty is invalid");
  }
  if (requiredRoles.size) throw new Error(`V6 calibrated equipment role is missing: ${[...requiredRoles].join(", ")}`);
  if (protocol.acceptance.independentRunsPerTargetCase !== V6_INDEPENDENT_RUNS_PER_TARGET_CASE || protocol.acceptance.unknownCanPass !== false || protocol.acceptance.guardOrShamAlertAllowed !== false || protocol.acceptance.overloadMustBeSeparate !== true) throw new Error("V6 acceptance criteria were weakened");
  const expectedCount = approvedBinding.targets.length * V6_CASE_KINDS.length * V6_INDEPENDENT_RUNS_PER_TARGET_CASE;
  if (!Array.isArray(protocol.matrix) || protocol.matrix.length !== expectedCount) throw new Error(`V6 test matrix is incomplete; expected ${expectedCount} independent cases`);
  const uniqueIds = new Set<string>();
  const uniquePaths = new Set<string>();
  const coverage = new Map<string, Set<number>>();
  for (const entry of protocol.matrix) {
    exactKeys(entry, ["caseId", "targetId", "kind", "independentRun", "acquisitionDescriptorPath", "rawTablePath", "evidencePath", "expected"], "V6 matrix case");
    exactKeys(entry.expected, ["outcome", "stimulusEnabled", "generatorFrequencyHz", "sourceLevelDbmAtGeneratorPort", "occupiedWidthHz", "maximumAbsoluteFrequencyErrorHz"], "V6 matrix expectation");
    assertSafeId(entry.caseId, "V6 case id");
    if (uniqueIds.has(entry.caseId)) throw new Error("V6 case id is duplicated");
    uniqueIds.add(entry.caseId);
    if (!approvedBinding.targets.some((target) => target.targetId === entry.targetId) || !V6_CASE_KINDS.includes(entry.kind)) throw new Error(`V6 case target/kind is outside the approved matrix: ${entry.caseId}`);
    assertInteger(entry.independentRun, `V6 ${entry.caseId} run`, 1, V6_INDEPENDENT_RUNS_PER_TARGET_CASE);
    const key = `${entry.targetId}\0${entry.kind}`;
    const runs = coverage.get(key) ?? new Set<number>();
    if (runs.has(entry.independentRun)) throw new Error(`V6 matrix repeats an independent run: ${entry.caseId}`);
    runs.add(entry.independentRun);
    coverage.set(key, runs);
    for (const [label, value] of Object.entries({ acquisition: entry.acquisitionDescriptorPath, rawTable: entry.rawTablePath, evidence: entry.evidencePath })) {
      const relative = safeRelativePath(value, `V6 ${entry.caseId} ${label}`);
      if (uniquePaths.has(relative)) throw new Error("V6 case files may not be reused as independent runs");
      uniquePaths.add(relative);
    }
    if (entry.expected.outcome !== expectedOutcome(entry.kind)) throw new Error(`V6 expected outcome was weakened for ${entry.caseId}`);
    const enabled = entry.kind !== "sham" && entry.kind !== "target-range";
    if (entry.expected.stimulusEnabled !== enabled) throw new Error(`V6 stimulus state is invalid for ${entry.caseId}`);
    if (enabled) {
      assertFinite(entry.expected.generatorFrequencyHz, `V6 ${entry.caseId} generator frequency`, 1);
      if (!entry.expected.sourceLevelDbmAtGeneratorPort) throw new Error(`V6 ${entry.caseId} source-level envelope is missing`);
      exactKeys(entry.expected.sourceLevelDbmAtGeneratorPort, ["minimum", "maximum"], `V6 ${entry.caseId} source-level envelope`);
      assertFinite(entry.expected.sourceLevelDbmAtGeneratorPort.minimum, `V6 ${entry.caseId} source minimum`, -200, 100);
      assertFinite(entry.expected.sourceLevelDbmAtGeneratorPort.maximum, `V6 ${entry.caseId} source maximum`, entry.expected.sourceLevelDbmAtGeneratorPort.minimum, 100);
    } else if (entry.expected.generatorFrequencyHz !== null || entry.expected.sourceLevelDbmAtGeneratorPort !== null) throw new Error(`V6 ${entry.caseId} disabled stimulus contains generator settings`);
    if (["wideband", "cw", "multitone", "moving-narrowband"].includes(entry.kind)) {
      if (!entry.expected.occupiedWidthHz) throw new Error(`V6 ${entry.caseId} occupied-width envelope is missing`);
      exactKeys(entry.expected.occupiedWidthHz, ["minimum", "maximum"], `V6 ${entry.caseId} occupied-width envelope`);
      assertFinite(entry.expected.occupiedWidthHz.minimum, `V6 ${entry.caseId} width minimum`, 1);
      assertFinite(entry.expected.occupiedWidthHz.maximum, `V6 ${entry.caseId} width maximum`, entry.expected.occupiedWidthHz.minimum);
    } else if (entry.expected.occupiedWidthHz !== null) throw new Error(`V6 ${entry.caseId} has an inapplicable occupied-width envelope`);
    if (entry.kind === "frequency-accuracy") assertFinite(entry.expected.maximumAbsoluteFrequencyErrorHz, `V6 ${entry.caseId} frequency tolerance`, 0, 1_000_000);
    else if (entry.expected.maximumAbsoluteFrequencyErrorHz !== null) throw new Error(`V6 ${entry.caseId} has an inapplicable frequency tolerance`);
  }
  for (const target of approvedBinding.targets) for (const kind of V6_CASE_KINDS) {
    if (coverage.get(`${target.targetId}\0${kind}`)?.size !== V6_INDEPENDENT_RUNS_PER_TARGET_CASE) throw new Error(`V6 matrix is incomplete for ${target.targetId}/${kind}`);
  }
}

function validateManifestShape(manifest: V6CampaignManifest): void {
  exactKeys(manifest, ["schemaVersion", "recordType", "frameworkVersion", "campaignId", "createdAt", "protocol", "declaredResult", "files", "evidenceTreeSha256", "protocolWitness", "finalWitness"], "V6 campaign manifest");
  if (manifest.schemaVersion !== 1 || manifest.recordType !== "rf-monitor-v6-conducted-campaign" || manifest.frameworkVersion !== V6_CONDUCTED_FRAMEWORK_VERSION) throw new Error("V6 campaign manifest schema/framework is invalid");
  assertSafeId(manifest.campaignId, "V6 manifest campaign id");
  assertIso(manifest.createdAt, "V6 manifest creation time");
  safeRelativePath(manifest.protocol.path, "V6 protocol path");
  safeRelativePath(manifest.declaredResult.path, "V6 declared-result path");
  exactKeys(manifest.protocol, ["path", "sha256"], "V6 protocol file reference");
  exactKeys(manifest.declaredResult, ["path", "sha256"], "V6 declared-result file reference");
  assertHash(manifest.protocol.sha256, "V6 protocol hash");
  assertHash(manifest.declaredResult.sha256, "V6 declared-result hash");
  assertHash(manifest.evidenceTreeSha256, "V6 evidence-tree hash");
  for (const [label, envelope] of [["protocol", manifest.protocolWitness], ["final", manifest.finalWitness]] as const) {
    exactKeys(envelope, ["receiptId", "statement", "statementSha256", "keySha256", "signatureAlgorithm", "signatureBase64"], `V6 ${label} witness envelope`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_CAMPAIGN_FILES) throw new Error("V6 manifest file set is empty or unbounded");
  let previous = "";
  let totalBytes = 0;
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "bytes", "sha256"], "V6 campaign file entry");
    const relative = safeRelativePath(entry.path, "V6 manifest file");
    if (relative === CAMPAIGN_MANIFEST_FILE || relative.localeCompare(previous) <= 0) throw new Error("V6 manifest file list must be unique, sorted, and exclude itself");
    previous = relative;
    assertInteger(entry.bytes, `V6 ${relative} bytes`, 1, maximumForPath(relative));
    assertHash(entry.sha256, `V6 ${relative} hash`);
    totalBytes += entry.bytes;
    if (totalBytes > MAX_CAMPAIGN_BYTES) throw new Error("V6 campaign exceeds its byte bound");
  }
  if (manifest.evidenceTreeSha256 !== sha256CanonicalV6(manifest.files)) throw new Error("V6 evidence-tree digest does not match the sorted file manifest");
}

export function v6CaseResultFingerprint(scores: V6CaseScore[]): string {
  return sha256CanonicalV6(scores);
}

export function scoreV6MeasurementCase(entry: V6MatrixCase, raw: V6RawMeasurementTable, target: V6ApprovedTargetBinding): V6CaseScore {
  const failures: string[] = [];
  const expectedCaptureStart = target.centerHz - target.captureSpanHz / 2;
  const expectedCaptureEnd = target.centerHz + target.captureSpanHz / 2;
  const expectedAnalysisStart = target.centerHz - target.analysisSpanHz / 2;
  const expectedAnalysisEnd = target.centerHz + target.analysisSpanHz / 2;
  if (raw.observation.confirmedCenterHz !== target.centerHz || raw.observation.confirmedSampleRateHz !== PRODUCTION_SAMPLE_RATE_HZ) failures.push("confirmed-rf-state-mismatch");
  if (raw.observation.captureStartHz !== expectedCaptureStart || raw.observation.captureEndHz !== expectedCaptureEnd || raw.observation.analysisStartHz !== expectedAnalysisStart || raw.observation.analysisEndHz !== expectedAnalysisEnd) failures.push("capture-or-analysis-range-mismatch");
  if (raw.observation.acceptedFrames < 3) failures.push("insufficient-accepted-frames");
  if (raw.observation.invalidOrStaleFrames !== 0) failures.push("invalid-or-stale-frame-present");
  if (raw.observation.outcome === "unknown") failures.push("unknown-cannot-pass");
  if (raw.stimulus.enabled !== entry.expected.stimulusEnabled || raw.stimulus.generatorFrequencyHz !== entry.expected.generatorFrequencyHz) failures.push("stimulus-does-not-match-precommitment");
  if (entry.expected.sourceLevelDbmAtGeneratorPort) {
    const level = raw.stimulus.sourceLevelDbmAtGeneratorPort;
    if (level === null || level < entry.expected.sourceLevelDbmAtGeneratorPort.minimum || level > entry.expected.sourceLevelDbmAtGeneratorPort.maximum) failures.push("source-level-outside-predeclared-envelope");
  } else if (raw.stimulus.sourceLevelDbmAtGeneratorPort !== null) failures.push("unexpected-source-level");
  if (entry.expected.occupiedWidthHz) {
    const width = raw.stimulus.occupiedWidthHz;
    if (width === null || width < entry.expected.occupiedWidthHz.minimum || width > entry.expected.occupiedWidthHz.maximum) failures.push("occupied-width-outside-predeclared-envelope");
  } else if (raw.stimulus.occupiedWidthHz !== null) failures.push("unexpected-occupied-width");
  const kinds = new Set(raw.observation.alertKinds);
  if (entry.kind === "target-range") {
    if (raw.observation.outcome !== "metadata-match" || raw.observation.attributedTargetId !== entry.targetId || kinds.size || raw.observation.overloadObserved) failures.push("target-range-metadata-mismatch");
  } else if (entry.kind === "frequency-accuracy") {
    const peak = raw.observation.observedPeakHz;
    if (raw.observation.outcome !== "metadata-match" || raw.observation.attributedTargetId !== entry.targetId || peak === null || entry.expected.generatorFrequencyHz === null || entry.expected.maximumAbsoluteFrequencyErrorHz === null || Math.abs(peak - entry.expected.generatorFrequencyHz) > entry.expected.maximumAbsoluteFrequencyErrorHz || kinds.size || raw.observation.overloadObserved) failures.push("frequency-accuracy-failed");
  } else if (entry.kind === "wideband") {
    if (raw.observation.outcome !== "alert" || raw.observation.attributedTargetId !== entry.targetId || !kinds.has("wideband-rise") || kinds.has("overload") || raw.observation.overloadObserved) failures.push("wideband-detection-failed");
  } else if (["cw", "multitone", "moving-narrowband"].includes(entry.kind)) {
    if (raw.observation.outcome !== "alert" || raw.observation.attributedTargetId !== entry.targetId || !kinds.has("narrowband-spike") || kinds.has("overload") || raw.observation.overloadObserved) failures.push("narrowband-detection-failed");
  } else if (entry.kind === "overload") {
    if (raw.observation.outcome !== "overload" || raw.observation.attributedTargetId !== entry.targetId || !raw.observation.overloadObserved || kinds.size !== 1 || !kinds.has("overload")) failures.push("overload-not-separated");
  } else if (entry.kind === "guard-only" || entry.kind === "sham") {
    if (raw.observation.outcome !== "no-alert" || raw.observation.attributedTargetId !== null || kinds.size || raw.observation.overloadObserved) failures.push(`${entry.kind}-unexpected-alert`);
    if (entry.kind === "guard-only" && entry.expected.generatorFrequencyHz !== null && entry.expected.generatorFrequencyHz >= expectedAnalysisStart && entry.expected.generatorFrequencyHz <= expectedAnalysisEnd) failures.push("guard-stimulus-inside-analysis-mask");
    if (entry.kind === "guard-only" && entry.expected.generatorFrequencyHz !== null && (entry.expected.generatorFrequencyHz < expectedCaptureStart || entry.expected.generatorFrequencyHz > expectedCaptureEnd)) failures.push("guard-stimulus-outside-capture");
  }
  const absoluteFrequencyErrorHz = raw.stimulus.generatorFrequencyHz !== null && raw.observation.observedPeakHz !== null
    ? Math.abs(raw.observation.observedPeakHz - raw.stimulus.generatorFrequencyHz)
    : null;
  return {
    caseId: entry.caseId,
    targetId: entry.targetId,
    kind: entry.kind,
    independentRun: entry.independentRun,
    observedOutcome: raw.observation.outcome,
    passed: failures.length === 0,
    failureReasons: failures,
    measured: {
      generatorFrequencyHz: raw.stimulus.generatorFrequencyHz,
      sourceLevelDbmAtGeneratorPort: raw.stimulus.sourceLevelDbmAtGeneratorPort,
      occupiedWidthHz: raw.stimulus.occupiedWidthHz,
      observedPeakHz: raw.observation.observedPeakHz,
      absoluteFrequencyErrorHz,
      frequencyUncertaintyHz: raw.uncertainty.frequencyHz,
      sourceLevelUncertaintyDb: raw.uncertainty.sourceLevelDb,
    },
  };
}

function envelopeRange(values: Array<number | null>): { minimum: number; maximum: number } | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finite.length ? { minimum: Math.min(...finite), maximum: Math.max(...finite) } : null;
}

async function loadAndVerifyFiles(root: string, manifest: V6CampaignManifest): Promise<{ totalBytes: number; manifestSha256: string }> {
  const actualFiles = await listTree(root);
  const expectedFiles = [...manifest.files.map((entry) => entry.path), CAMPAIGN_MANIFEST_FILE].sort();
  if (actualFiles.join("\0") !== expectedFiles.join("\0")) throw new Error("V6 campaign tree has missing or undeclared files");
  const manifestHash = await hashFile(resolveInside(root, CAMPAIGN_MANIFEST_FILE), MAX_JSON_BYTES);
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const actual = await hashFile(resolveInside(root, entry.path), maximumForPath(entry.path));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`V6 campaign file changed or does not match its manifest: ${entry.path}`);
    totalBytes += actual.bytes;
  }
  return { totalBytes, manifestSha256: manifestHash.sha256 };
}

export function v6PrerequisiteSourceSetFingerprint(sources: V6PrerequisiteSourceReference[]): string {
  return sha256CanonicalV6(sources);
}

function sourceRelease(value: unknown, label: string, candidate: V6CandidateContext): FrozenCandidateIdentity {
  if (!isRecord(value)) throw new Error(`${label} lacks an exact frozen release identity`);
  const release = value as unknown as FrozenCandidateIdentity;
  validateRelease(release, label);
  if (!sameCanonical(release, candidate.release)) throw new Error(`${label} belongs to a different candidate`);
  return release;
}

function sourceReleaseBinding(value: unknown, label: string, candidate: V6CandidateContext): void {
  if (!isRecord(value) || value.state !== "verified" || value.buildId !== candidate.release.buildId || value.sourceDigest !== candidate.release.sourceDigest || value.packageDigest !== candidate.release.packageDigest) throw new Error(`${label} is not verified for the exact frozen candidate`);
}

function sourceResult(value: Record<string, unknown>, label: string): Record<string, unknown> {
  if (!isRecord(value.result)) throw new Error(`${label} has no structured result`);
  return value.result;
}

function validateV0Source(value: Record<string, unknown>, candidate: V6CandidateContext): void {
  if (value.schemaVersion !== 2 || value.valid !== true || !Array.isArray(value.qualificationGates) || value.qualificationGates.join("\0") !== Array.from({ length: 8 }, (_, index) => `V${index}`).join("\0")) throw new Error("V6 V0 source is not a complete schema-v2 V0-V7 traceability validation report");
  sourceReleaseBinding(value.releaseBinding, "V6 V0 release binding", candidate);
}

function validateV1Source(value: Record<string, unknown>, candidate: V6CandidateContext): void {
  if (value.schemaVersion !== 1 || value.recordType !== "rf-monitor-validation" || value.gate !== "V1") throw new Error("V6 V1 source is not an RF Monitor validation record");
  sourceRelease(value.release, "V6 V1 release", candidate);
  const result = sourceResult(value, "V6 V1 source");
  if (result.state !== "passed" || result.softwareGatePassed !== true || result.productionReady !== false || result.physicalQualification !== "not-run") throw new Error("V6 V1 validation record does not report a software PASS");
  if (!isRecord(value.testSummary) || value.testSummary.failedTests !== 0 || value.testSummary.skippedTests !== 0 || value.testSummary.failedTestFiles !== 0 || value.testSummary.skippedTestFiles !== 0) throw new Error("V6 V1 validation record contains failed or skipped checks");
}

function validateV2Source(value: Record<string, unknown>, candidate: V6CandidateContext): void {
  if (value.schemaVersion !== 1 || value.gate !== "V2" || value.qualification !== "packaged-process-and-storage-boundaries" || value.result !== "PASS" || value.softwareQualificationOnly !== true || value.productionQualified !== false) throw new Error("V6 V2 source is not the packaged process/storage PASS record");
  sourceRelease(value.release, "V6 V2 release", candidate);
}

function validateV3Source(value: Record<string, unknown>, candidate: V6CandidateContext): void {
  if (value.schemaVersion !== 1 || value.recordType !== "rf-monitor-v3-packaged-browser-result" || value.gate !== "V3" || value.packaged !== true || value.configurationSha256 !== candidate.configurationSha256) throw new Error("V6 V3 source is not the exact packaged browser result");
  sourceRelease(value.release, "V6 V3 release", candidate);
  const result = sourceResult(value, "V6 V3 source");
  if (result.gateDecision !== "passed" || result.productionReady !== false || !isRecord(value.accessibility) || value.accessibility.violations !== 0 || value.operatorWorkflowsPassed !== true) throw new Error("V6 V3 packaged browser source did not pass accessibility and operator workflows");
}

function validateV4Sources(sources: Map<V6PrerequisiteSourceRole, { reference: V6PrerequisiteSourceReference; value: Record<string, unknown> }>, candidate: V6CandidateContext): void {
  const packaged = sources.get("packaged-result")!;
  const detector = sources.get("detector-result")!;
  const combined = sources.get("combined-result")!;
  if (packaged.value.schemaVersion !== 1 || packaged.value.recordType !== "rf-monitor-v4-packaged-end-to-end-result" || !isRecord(packaged.value.release) || packaged.value.release.unchanged !== true) throw new Error("V6 V4 packaged source identity is invalid");
  sourceRelease(packaged.value.release.before, "V6 V4 packaged release before", candidate);
  sourceRelease(packaged.value.release.after, "V6 V4 packaged release after", candidate);
  const packagedResult = sourceResult(packaged.value, "V6 V4 packaged source");
  if (packagedResult.packagedEndToEndSubGate !== "passed" || packagedResult.overallV4 !== "not-passed" || packagedResult.productionReady !== false) throw new Error("V6 V4 packaged sub-gate did not pass");
  if (detector.value.schemaVersion !== 1 || detector.value.recordType !== "rf-monitor-v4-detector-campaign-result" || detector.value.executedCases !== 16_040 || !isRecord(detector.value.candidate) || detector.value.candidate.unchanged !== true) throw new Error("V6 V4 detector source is not the complete 16,040-case result");
  sourceRelease(detector.value.candidate.before, "V6 V4 detector release before", candidate);
  sourceRelease(detector.value.candidate.after, "V6 V4 detector release after", candidate);
  const detectorResult = sourceResult(detector.value, "V6 V4 detector source");
  if (detectorResult.detectorStatisticalSubGate !== "passed" || detectorResult.overallV4 !== "not-passed" || detectorResult.productionReady !== false) throw new Error("V6 V4 detector sub-gate did not pass");
  if (combined.value.schemaVersion !== 1 || combined.value.recordType !== "rf-monitor-v4-combined-result" || combined.value.gate !== "V4" || combined.value.configurationSha256 !== candidate.configurationSha256 || combined.value.packagedResultSha256 !== packaged.reference.artifactSha256 || combined.value.detectorResultSha256 !== detector.reference.artifactSha256) throw new Error("V6 V4 combined result is absent or not bound to both exact sub-gates");
  sourceRelease(combined.value.release, "V6 V4 combined release", candidate);
  const combinedResult = sourceResult(combined.value, "V6 V4 combined source");
  if (combinedResult.gateDecision !== "passed" || combinedResult.productionReady !== false || combined.value.detectorCases !== 16_040) throw new Error("V6 combined V4 gate did not pass");
}

function validateV5Sources(sources: Map<V6PrerequisiteSourceRole, { reference: V6PrerequisiteSourceReference; value: Record<string, unknown> }>, candidate: V6CandidateContext, protocol: V6ConductedProtocol): void {
  const bundle = sources.get("bundle-manifest")!;
  const report = sources.get("replay-result")!;
  const verification = sources.get("verification-record")!;
  if (bundle.value.schemaVersion !== 1 || bundle.value.recordType !== "rf-monitor-v5-held-out-replay-bundle" || bundle.value.gate !== "V5" || bundle.value.gateDecision !== "passed" || bundle.value.productionReady !== false) throw new Error("V6 V5 source is not a passing replay bundle manifest");
  sourceRelease(bundle.value.release, "V6 V5 bundle release", candidate);
  if (!Array.isArray(bundle.value.files) || !bundle.value.files.some((entry) => isRecord(entry) && entry.path === "report.json" && entry.sha256 === report.reference.artifactSha256)) throw new Error("V6 V5 bundle manifest does not bind the exact replay report");
  if (report.value.schemaVersion !== 1 || report.value.recordType !== "rf-monitor-v5-held-out-replay-result" || report.value.gate !== "V5") throw new Error("V6 V5 replay result identity is invalid");
  sourceRelease(report.value.release, "V6 V5 report release", candidate);
  const replayResult = sourceResult(report.value, "V6 V5 replay result");
  if (replayResult.gateDecision !== "passed" || replayResult.allCriteriaPassed !== true || replayResult.corpusUnchanged !== true || replayResult.fieldTreeUnchanged !== true || replayResult.thresholdMutationDetected !== false || replayResult.productionReady !== false || !isRecord(report.value.externalWitness) || report.value.externalWitness.signatureVerified !== true) throw new Error("V6 V5 replay result did not independently pass its frozen criteria and custody checks");
  assertHash(report.value.externalWitness.keySha256, "V6 V5 original witness key hash");
  exactKeys(verification.value, ["schemaVersion", "recordType", "publicKeyPem", "verifierKeySha256", "statement", "statementSha256", "signatureAlgorithm", "signatureBase64"], "V6 V5 independent verification record");
  if (verification.value.schemaVersion !== 1 || verification.value.recordType !== "rf-monitor-v5-replay-verification" || typeof verification.value.publicKeyPem !== "string") throw new Error("V6 V5 independent verification record is absent or malformed");
  const verifierKey = witnessKey({ publicKeyPem: verification.value.publicKeyPem, expectedKeySha256: protocol.v5ReplayVerification.verifierKeySha256 });
  if (verification.value.verifierKeySha256 !== verifierKey.keySha256 || verifierKey.keySha256 !== protocol.v5ReplayVerification.verifierKeySha256) throw new Error("V6 V5 verifier key differs from the prewitnessed SPKI pin");
  const expectedStatement = createV5IndependentVerificationStatement({
    verifiedAt: isRecord(verification.value.statement) && typeof verification.value.statement.verifiedAt === "string" ? verification.value.statement.verifiedAt : "",
    release: candidate.release,
    configurationSha256: candidate.configurationSha256,
    bundleManifestSha256: bundle.reference.artifactSha256,
    reportSha256: report.reference.artifactSha256,
    v5WitnessKeySha256: report.value.externalWitness.keySha256,
    verifierIdentitySha256: protocol.v5ReplayVerification.verifierIdentitySha256,
  });
  if (!sameCanonical(verification.value.statement, expectedStatement)) throw new Error("V6 V5 independent verifier statement is stale or forged");
  assertIso(expectedStatement.verifiedAt, "V6 V5 independent verification time");
  if (Date.parse(expectedStatement.verifiedAt) > Date.parse(protocol.committedAt)) throw new Error("V6 V5 independent verification was not complete before the V6 protocol commitment");
  assertHash(expectedStatement.verifierIdentitySha256, "V6 V5 independent verifier identity");
  assertHash(verification.value.statementSha256, "V6 V5 verifier statement hash");
  if (verification.value.statementSha256 !== sha256CanonicalV6(expectedStatement) || verification.value.signatureAlgorithm !== "ed25519") throw new Error("V6 V5 independent verifier statement hash/algorithm is invalid");
  let signature: Buffer;
  try { signature = Buffer.from(String(verification.value.signatureBase64), "base64"); } catch { throw new Error("V6 V5 independent verifier signature encoding is invalid"); }
  if (signature.byteLength !== 64 || !verifySignature(null, v5IndependentVerifierMessage(expectedStatement), verifierKey.key, signature)) throw new Error("V6 V5 independent verifier signature verification failed");
  if (Object.values(protocol.identities).includes(expectedStatement.verifierIdentitySha256)) throw new Error("V6 V5 replay verifier must be distinct from V6 implementer, custody, and witness identities");
}

async function validatePrerequisiteArtifact(root: string, prerequisite: V6PrerequisiteReference, candidate: V6CandidateContext, fileMap: Map<string, V6CampaignFileEntry>, protocol: V6ConductedProtocol): Promise<void> {
  const wrapper = (await readJson<V6PrerequisiteWrapper>(resolveInside(root, prerequisite.artifactPath), MAX_PREREQUISITE_BYTES)).value;
  exactKeys(wrapper, ["schemaVersion", "recordType", "gate", "decision", "completedAt", "release", "configurationSha256", "sources", "sourceSetSha256"], `V6 ${prerequisite.gate} prerequisite wrapper`);
  if (wrapper.schemaVersion !== 1 || wrapper.recordType !== "rf-monitor-v6-prerequisite-wrapper" || wrapper.gate !== prerequisite.gate || wrapper.decision !== "passed" || wrapper.completedAt !== prerequisite.completedAt || wrapper.configurationSha256 !== candidate.configurationSha256 || !sameCanonical(wrapper.release, candidate.release)) throw new Error(`V6 prerequisite ${prerequisite.gate} wrapper is stale or not PASS`);
  sourceRelease(wrapper.release, `V6 ${prerequisite.gate} wrapper release`, candidate);
  const roles = V6_PREREQUISITE_SOURCE_ROLES[prerequisite.gate] as readonly V6PrerequisiteSourceRole[];
  if (!Array.isArray(wrapper.sources) || wrapper.sources.length !== roles.length || wrapper.sources.map((source) => source.role).join("\0") !== roles.join("\0") || wrapper.sourceSetSha256 !== v6PrerequisiteSourceSetFingerprint(wrapper.sources)) throw new Error(`V6 prerequisite ${prerequisite.gate} wrapper source set is incomplete or reordered`);
  const sourcePaths = new Set<string>();
  const loaded = new Map<V6PrerequisiteSourceRole, { reference: V6PrerequisiteSourceReference; value: Record<string, unknown> }>();
  for (const source of wrapper.sources) {
    exactKeys(source, ["role", "artifactPath", "artifactSha256"], `V6 ${prerequisite.gate} source reference`);
    const relative = safeRelativePath(source.artifactPath, `V6 ${prerequisite.gate} ${source.role} source`);
    if (relative === prerequisite.artifactPath || sourcePaths.has(relative)) throw new Error(`V6 prerequisite ${prerequisite.gate} source path is reused`);
    sourcePaths.add(relative);
    assertHash(source.artifactSha256, `V6 ${prerequisite.gate} ${source.role} source hash`);
    const listed = fileMap.get(relative);
    if (!listed || listed.sha256 !== source.artifactSha256) throw new Error(`V6 prerequisite ${prerequisite.gate} source is missing or rehashed incorrectly: ${source.role}`);
    const value = (await readJson<Record<string, unknown>>(resolveInside(root, relative), MAX_PREREQUISITE_BYTES)).value;
    loaded.set(source.role, { reference: source, value });
  }
  if (prerequisite.gate === "V0") validateV0Source(loaded.get("traceability-report")!.value, candidate);
  else if (prerequisite.gate === "V1") validateV1Source(loaded.get("validation-record")!.value, candidate);
  else if (prerequisite.gate === "V2") validateV2Source(loaded.get("qualification-record")!.value, candidate);
  else if (prerequisite.gate === "V3") validateV3Source(loaded.get("browser-result")!.value, candidate);
  else if (prerequisite.gate === "V4") validateV4Sources(loaded, candidate);
  else validateV5Sources(loaded, candidate, protocol);
}

export async function runV6ConductedQualification(options: V6RunOptions): Promise<V6ConductedReport> {
  const root = await canonicalDirectory(options.campaignRoot, "V6 campaign root", true);
  assertHash(options.approvedBindingSha256, "V6 approved binding fingerprint");
  if (sha256CanonicalV6(options.approvedBinding) !== options.approvedBindingSha256) throw new Error("V6 separately approved binding fingerprint mismatch");
  validateV6ApprovedBinding(options.approvedBinding, options.candidate);
  const key = witnessKey(options.witness);
  const manifestRead = await readJson<V6CampaignManifest>(resolveInside(root, CAMPAIGN_MANIFEST_FILE));
  const manifest = manifestRead.value;
  validateManifestShape(manifest);
  const firstTree = await loadAndVerifyFiles(root, manifest);
  const protocolRead = await readJson<V6ConductedProtocol>(resolveInside(root, manifest.protocol.path));
  if (protocolRead.sha256 !== manifest.protocol.sha256) throw new Error("V6 protocol hash mismatch");
  const protocol = protocolRead.value;
  if (manifest.campaignId !== protocol.campaignId) throw new Error("V6 campaign/protocol id mismatch");
  validateProtocol(protocol, options.candidate, options.approvedBinding, options.approvedBindingSha256);
  if (protocol.v5ReplayVerification.verifierKeySha256 === key.keySha256) throw new Error("V6 V5 replay-verifier key must be distinct from the V6 witness key");
  const fileMap = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const prerequisite of protocol.prerequisites) {
    const listed = fileMap.get(prerequisite.artifactPath);
    if (!listed || listed.sha256 !== prerequisite.artifactSha256) throw new Error(`V6 prerequisite artifact is absent or stale: ${prerequisite.gate}`);
    await validatePrerequisiteArtifact(root, prerequisite, options.candidate, fileMap, protocol);
  }
  const scores: V6CaseScore[] = [];
  const uniqueFftPaths = new Set<string>();
  const uniqueAcquisitionIds = new Set<string>();
  let firstExposureMs = Number.POSITIVE_INFINITY;
  let lastExposureMs = Number.NEGATIVE_INFINITY;
  const exposureIntervals = new Map<string, { first: number; last: number }>();
  for (const entry of protocol.matrix) {
    const descriptorRead = await readJson<V6AcquisitionDescriptor>(resolveInside(root, entry.acquisitionDescriptorPath));
    const rawRead = await readJson<V6RawMeasurementTable>(resolveInside(root, entry.rawTablePath));
    const descriptor = descriptorRead.value;
    const raw = rawRead.value;
    exactKeys(descriptor, ["schemaVersion", "recordType", "campaignId", "caseId", "acquisitionId", "firstExposureAt", "lastExposureAt", "source", "target", "fft"], `V6 ${entry.caseId} acquisition descriptor`);
    exactKeys(descriptor.source, ["receiverModel", "receiverSerialSha256", "installedChainFingerprintSha256", "sdrconnectVersion", "fixedGainProfileSha256", "sampleRateHz", "normalizedEncoding", "realReceiver", "synthetic", "simulation", "replay", "iq", "dataDomain", "coupling", "radiated"], `V6 ${entry.caseId} acquisition source`);
    exactKeys(descriptor.target, ["targetId", "centerHz", "captureSpanHz", "analysisSpanHz", "analysisMaskSha256", "baselineId", "baselineDescriptorSha256", "baselineFingerprintSha256"], `V6 ${entry.caseId} acquisition target`);
    exactKeys(descriptor.fft, ["path", "rows", "inputBinCount", "bytes"], `V6 ${entry.caseId} FFT descriptor`);
    exactKeys(raw, ["schemaVersion", "recordType", "campaignId", "caseId", "acquisitionId", "targetId", "kind", "dataDomain", "coupling", "radiated", "iq", "stimulus", "observation", "uncertainty"], `V6 ${entry.caseId} raw measurement`);
    exactKeys(raw.stimulus, ["enabled", "generatorFrequencyHz", "sourceLevelDbmAtGeneratorPort", "occupiedWidthHz"], `V6 ${entry.caseId} stimulus measurement`);
    exactKeys(raw.observation, ["outcome", "attributedTargetId", "confirmedCenterHz", "confirmedSampleRateHz", "captureStartHz", "captureEndHz", "analysisStartHz", "analysisEndHz", "observedPeakHz", "alertKinds", "overloadObserved", "acceptedFrames", "invalidOrStaleFrames"], `V6 ${entry.caseId} detector observation`);
    exactKeys(raw.uncertainty, ["frequencyHz", "sourceLevelDb"], `V6 ${entry.caseId} uncertainty record`);
    if (descriptor.schemaVersion !== 1 || descriptor.recordType !== "rf-monitor-v6-conducted-acquisition" || descriptor.campaignId !== protocol.campaignId || descriptor.caseId !== entry.caseId) throw new Error(`V6 acquisition descriptor is mismatched: ${entry.caseId}`);
    assertSafeId(descriptor.acquisitionId, `V6 ${entry.caseId} acquisition id`);
    if (uniqueAcquisitionIds.has(descriptor.acquisitionId)) throw new Error(`V6 independent cases may not reuse an acquisition id: ${entry.caseId}`);
    uniqueAcquisitionIds.add(descriptor.acquisitionId);
    assertIso(descriptor.firstExposureAt, `V6 ${entry.caseId} first exposure`);
    assertIso(descriptor.lastExposureAt, `V6 ${entry.caseId} last exposure`);
    const first = Date.parse(descriptor.firstExposureAt);
    const last = Date.parse(descriptor.lastExposureAt);
    if (last < first) throw new Error(`V6 acquisition chronology is invalid: ${entry.caseId}`);
    firstExposureMs = Math.min(firstExposureMs, first);
    lastExposureMs = Math.max(lastExposureMs, last);
    exposureIntervals.set(entry.caseId, { first, last });
    const source = descriptor.source;
    if (source.receiverModel !== options.approvedBinding.receiver.model || source.receiverSerialSha256 !== options.approvedBinding.receiver.serialSha256 || source.installedChainFingerprintSha256 !== options.approvedBinding.installedChain.fingerprintSha256 || source.sdrconnectVersion !== options.approvedBinding.rf.sdrconnectVersion || source.fixedGainProfileSha256 !== options.approvedBinding.rf.fixedGainProfileSha256 || source.sampleRateHz !== PRODUCTION_SAMPLE_RATE_HZ) throw new Error(`V6 acquisition RF-chain binding is stale: ${entry.caseId}`);
    if (source.normalizedEncoding !== "uint8-display-values" || source.realReceiver !== true || source.synthetic !== false || source.simulation !== false || source.replay !== false || source.iq !== false || source.dataDomain !== "test" || source.coupling !== "conducted-shielded" || source.radiated !== false) throw new Error(`V6 acquisition violates the real conducted/shielded test-domain boundary: ${entry.caseId}`);
    const target = options.approvedBinding.targets.find((candidate) => candidate.targetId === entry.targetId)!;
    if (!sameCanonical(descriptor.target, target)) throw new Error(`V6 acquisition target/baseline/mask binding is stale: ${entry.caseId}`);
    const fftPath = safeRelativePath(descriptor.fft.path, `V6 ${entry.caseId} FFT path`);
    if (uniqueFftPaths.has(fftPath)) throw new Error(`V6 independent acquisitions may not reuse an FFT payload: ${entry.caseId}`);
    uniqueFftPaths.add(fftPath);
    const fftListed = fileMap.get(fftPath);
    assertInteger(descriptor.fft.rows, `V6 ${entry.caseId} FFT rows`, 1, 1_000_000);
    if (descriptor.fft.inputBinCount !== options.approvedBinding.rf.inputBinCount) throw new Error(`V6 FFT grid mismatch: ${entry.caseId}`);
    const expectedFftBytes = descriptor.fft.rows * descriptor.fft.inputBinCount;
    if (!Number.isSafeInteger(expectedFftBytes) || descriptor.fft.bytes !== expectedFftBytes || !fftListed || fftListed.bytes !== expectedFftBytes || !fftPath.endsWith(".uint8")) throw new Error(`V6 normalized uint8 FFT payload is incomplete: ${entry.caseId}`);
    if (raw.schemaVersion !== 1 || raw.recordType !== "rf-monitor-v6-raw-measurement" || raw.campaignId !== protocol.campaignId || raw.caseId !== entry.caseId || raw.acquisitionId !== descriptor.acquisitionId || raw.targetId !== entry.targetId || raw.kind !== entry.kind) throw new Error(`V6 raw table identity is mismatched: ${entry.caseId}`);
    if (raw.dataDomain !== "test" || raw.coupling !== "conducted-shielded" || raw.radiated !== false || raw.iq !== false) throw new Error(`V6 raw table violates test-domain/conducted/IQ limits: ${entry.caseId}`);
    for (const [label, value] of Object.entries({
      confirmedCenterHz: raw.observation.confirmedCenterHz,
      confirmedSampleRateHz: raw.observation.confirmedSampleRateHz,
      captureStartHz: raw.observation.captureStartHz,
      captureEndHz: raw.observation.captureEndHz,
      analysisStartHz: raw.observation.analysisStartHz,
      analysisEndHz: raw.observation.analysisEndHz,
    })) assertFinite(value, `V6 ${entry.caseId} ${label}`);
    if (raw.stimulus.generatorFrequencyHz !== null) assertFinite(raw.stimulus.generatorFrequencyHz, `V6 ${entry.caseId} measured generator frequency`, 1);
    if (raw.stimulus.sourceLevelDbmAtGeneratorPort !== null) assertFinite(raw.stimulus.sourceLevelDbmAtGeneratorPort, `V6 ${entry.caseId} measured source level`, -200, 100);
    if (raw.stimulus.occupiedWidthHz !== null) assertFinite(raw.stimulus.occupiedWidthHz, `V6 ${entry.caseId} measured occupied width`, 0);
    if (raw.observation.observedPeakHz !== null) assertFinite(raw.observation.observedPeakHz, `V6 ${entry.caseId} measured peak frequency`, 1);
    assertInteger(raw.observation.acceptedFrames, `V6 ${entry.caseId} accepted frames`, 0, 1_000_000);
    assertInteger(raw.observation.invalidOrStaleFrames, `V6 ${entry.caseId} invalid/stale frames`, 0, 1_000_000);
    if (!Array.isArray(raw.observation.alertKinds) || raw.observation.alertKinds.length > 4 || new Set(raw.observation.alertKinds).size !== raw.observation.alertKinds.length || raw.observation.alertKinds.some((kind) => !["wideband-rise", "narrowband-spike", "slow-drift", "overload"].includes(kind))) throw new Error(`V6 ${entry.caseId} alert-kind record is invalid or duplicated`);
    assertFinite(raw.uncertainty.frequencyHz, `V6 ${entry.caseId} frequency uncertainty`, 0, 10_000_000);
    assertFinite(raw.uncertainty.sourceLevelDb, `V6 ${entry.caseId} source-level uncertainty`, 0, 100);
    scores.push(scoreV6MeasurementCase(entry, raw, target));
  }
  if (!Number.isFinite(firstExposureMs) || !Number.isFinite(lastExposureMs)) throw new Error("V6 campaign has no real exposure interval");
  const firstExposureAt = new Date(firstExposureMs).toISOString();
  const lastExposureAt = new Date(lastExposureMs).toISOString();
  const orderedExposures = [...exposureIntervals.entries()].sort((left, right) => left[1].first - right[1].first);
  for (let index = 1; index < orderedExposures.length; index += 1) {
    if (orderedExposures[index][1].first < orderedExposures[index - 1][1].last) throw new Error(`V6 independent acquisition intervals overlap: ${orderedExposures[index - 1][0]} / ${orderedExposures[index][0]}`);
  }
  for (const equipment of protocol.equipment) {
    const listed = fileMap.get(equipment.certificatePath);
    if (!listed || listed.sha256 !== equipment.certificateSha256) throw new Error(`V6 calibration certificate is absent or stale: ${equipment.equipmentId}`);
    if (Date.parse(equipment.calibrationValidFrom) > firstExposureMs || Date.parse(equipment.calibrationValidUntil) < lastExposureMs) throw new Error(`V6 calibration expired outside the complete exposure interval: ${equipment.equipmentId}`);
  }
  const expectedProtocolStatement = createV6ProtocolWitnessStatement({
    campaignId: protocol.campaignId,
    protocolSha256: protocolRead.sha256,
    approvedBindingSha256: options.approvedBindingSha256,
    protocolCommittedAt: protocol.committedAt,
    signedAt: manifest.protocolWitness.statement.signedAt,
    firstExposureNotBefore: manifest.protocolWitness.statement.firstExposureNotBefore,
    ...protocol.identities,
  });
  assertIso(expectedProtocolStatement.signedAt, "V6 protocol witness time");
  assertIso(expectedProtocolStatement.firstExposureNotBefore, "V6 first-exposure not-before time");
  if (Date.parse(protocol.committedAt) > Date.parse(expectedProtocolStatement.signedAt) || Date.parse(expectedProtocolStatement.signedAt) > firstExposureMs || Date.parse(expectedProtocolStatement.firstExposureNotBefore) > firstExposureMs || Date.parse(expectedProtocolStatement.signedAt) > Date.parse(expectedProtocolStatement.firstExposureNotBefore)) throw new Error("V6 protocol was not witnessed before the first RF exposure");
  verifyWitnessEnvelope(manifest.protocolWitness, expectedProtocolStatement, key.key, key.keySha256, "V6 protocol witness");
  const declaredRead = await readJson<V6DeclaredResult>(resolveInside(root, manifest.declaredResult.path));
  if (declaredRead.sha256 !== manifest.declaredResult.sha256) throw new Error("V6 declared-result hash mismatch");
  const allPassed = scores.every((score) => score.passed);
  const decision = allPassed ? "passed" : "failed";
  const declared = declaredRead.value;
  exactKeys(declared, ["schemaVersion", "recordType", "campaignId", "protocolSha256", "completedAt", "expectedCases", "caseResultSha256", "decision"], "V6 declared result");
  if (declared.schemaVersion !== 1 || declared.recordType !== "rf-monitor-v6-declared-result" || declared.campaignId !== protocol.campaignId || declared.protocolSha256 !== protocolRead.sha256 || declared.expectedCases !== scores.length || declared.caseResultSha256 !== v6CaseResultFingerprint(scores) || declared.decision !== decision) throw new Error("V6 final declared result does not match mechanical scoring");
  assertIso(declared.completedAt, "V6 declared-result completion");
  if (Date.parse(declared.completedAt) < lastExposureMs) throw new Error("V6 declared result predates the last exposure");
  const expectedFinalStatement = createV6FinalWitnessStatement({
    campaignId: protocol.campaignId,
    protocolSha256: protocolRead.sha256,
    evidenceTreeSha256: manifest.evidenceTreeSha256,
    declaredResultSha256: declaredRead.sha256,
    caseResultSha256: declared.caseResultSha256,
    declaredDecision: declared.decision,
    firstExposureAt,
    lastExposureAt,
    signedAt: manifest.finalWitness.statement.signedAt,
    ...protocol.identities,
  });
  assertIso(expectedFinalStatement.signedAt, "V6 final witness time");
  if (Date.parse(expectedFinalStatement.signedAt) < lastExposureMs || Date.parse(expectedFinalStatement.signedAt) < Date.parse(declared.completedAt)) throw new Error("V6 final campaign/tree result was not witnessed after the last exposure and declared result");
  verifyWitnessEnvelope(manifest.finalWitness, expectedFinalStatement, key.key, key.keySha256, "V6 final witness");
  const secondTree = await loadAndVerifyFiles(root, manifest);
  if (secondTree.manifestSha256 !== firstTree.manifestSha256 || secondTree.totalBytes !== firstTree.totalBytes) throw new Error("V6 campaign tree changed during qualification");
  const byTargetKind = options.approvedBinding.targets.flatMap((target) => V6_CASE_KINDS.map((kind) => {
    const selected = scores.filter((score) => score.targetId === target.targetId && score.kind === kind);
    return { targetId: target.targetId, kind, runs: selected.length, passed: selected.filter((score) => score.passed).length, failed: selected.filter((score) => !score.passed).length };
  }));
  const testedEnvelope = byTargetKind.map(({ targetId, kind }) => {
    const selected = scores.filter((score) => score.targetId === targetId && score.kind === kind);
    return {
      targetId,
      kind,
      sourceLevelDbmAtGeneratorPort: envelopeRange(selected.map((score) => score.measured.sourceLevelDbmAtGeneratorPort)),
      generatorFrequencyHz: envelopeRange(selected.map((score) => score.measured.generatorFrequencyHz)),
      occupiedWidthHz: envelopeRange(selected.map((score) => score.measured.occupiedWidthHz)),
      maximumFrequencyErrorHz: envelopeRange(selected.map((score) => score.measured.absoluteFrequencyErrorHz))?.maximum ?? null,
      maximumFrequencyUncertaintyHz: Math.max(...selected.map((score) => score.measured.frequencyUncertaintyHz)),
      maximumSourceLevelUncertaintyDb: Math.max(...selected.map((score) => score.measured.sourceLevelUncertaintyDb)),
    };
  });
  const counts = { cases: scores.length, passed: scores.filter((score) => score.passed).length, failed: scores.filter((score) => !score.passed).length, unknown: scores.filter((score) => score.observedOutcome === "unknown").length };
  const deterministicResultHash = sha256CanonicalV6({ release: options.candidate.release, approvedBindingSha256: options.approvedBindingSha256, campaignId: protocol.campaignId, protocolSha256: protocolRead.sha256, evidenceTreeSha256: manifest.evidenceTreeSha256, scores, decision });
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-conducted-result",
    frameworkVersion: V6_CONDUCTED_FRAMEWORK_VERSION,
    gate: "V6",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    runId: options.runId ?? randomUUID(),
    campaignId: protocol.campaignId,
    release: options.candidate.release,
    approvedBindingSha256: options.approvedBindingSha256,
    binding: options.approvedBinding,
    campaign: { manifestSha256: firstTree.manifestSha256, protocolSha256: protocolRead.sha256, declaredResultSha256: declaredRead.sha256, evidenceTreeSha256: manifest.evidenceTreeSha256, files: manifest.files.length, bytes: firstTree.totalBytes, firstExposureAt, lastExposureAt },
    witness: {
      keySha256: key.keySha256,
      protocol: { ...manifest.protocolWitness, verified: true },
      final: { ...manifest.finalWitness, verified: true },
      custodyStatementOnly: true,
    },
    cases: scores,
    byTargetKind,
    testedEnvelope,
    counts,
    result: { gateDecision: decision, completeMatrix: true, prerequisiteGatesPassed: true, calibratedEquipmentInDate: true, fieldDataWritten: false, productionReady: false },
    deterministicResultHash,
    limitations: [
      "This result applies only to the exact receiver model, serial hash, installed-chain fingerprint, configuration, site, protected baselines, sample rate, FFT grid, analysis masks, and tested conducted envelope in the approved binding.",
      "Normalized uint8 display values are relative and are not calibrated dBm or field strength.",
      "Generator-port settings and calibration uncertainty characterize only the conducted test reference plane; they do not establish antenna sensitivity or passive reception performance.",
      "This campaign does not classify spoofing, determine intent, or assess navigation integrity.",
      "Witness signatures authenticate the signed protocol and evidence-custody statement; they cannot prove that a physical connection, stimulus, observation, or label is true.",
      "A separate campaign is required for RSPdx and RSPdx R2 and for every receiver serial or installed-chain fingerprint change.",
      "V7 and the exact external V0-V7 approval remain separate from this V6 result.",
    ],
  };
}

async function writeExclusiveJson(filePath: string, value: unknown): Promise<{ sha256: string; bytes: number }> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!bytes.byteLength || bytes.byteLength > MAX_RESULT_BYTES) throw new Error("V6 result payload exceeds its bound");
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: sha256Bytes(bytes), bytes: bytes.byteLength };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeV6ConductedBundle(outputRoot: string, report: V6ConductedReport): Promise<string> {
  assertSafeId(report.campaignId, "V6 report campaign id");
  assertSafeId(report.runId, "V6 report run id");
  const canonicalOutput = await canonicalPotentialDirectory(outputRoot, "V6 output root");
  await mkdir(canonicalOutput, { recursive: true, mode: 0o750 });
  const target = path.join(canonicalOutput, `v6-${report.campaignId}-${report.runId}`);
  const partial = path.join(canonicalOutput, `.v6-${report.campaignId}-${report.runId}.partial-${randomUUID()}`);
  try {
    await mkdir(partial, { mode: 0o700 });
    const reportFile = await writeExclusiveJson(path.join(partial, "report.json"), report);
    const manifest = {
      schemaVersion: 1,
      recordType: "rf-monitor-v6-result-bundle",
      campaignId: report.campaignId,
      runId: report.runId,
      gateDecision: report.result.gateDecision,
      release: report.release,
      approvedBindingSha256: report.approvedBindingSha256,
      evidenceTreeSha256: report.campaign.evidenceTreeSha256,
      witnessKeySha256: report.witness.keySha256,
      files: [{ path: "report.json", ...reportFile }],
    };
    await writeExclusiveJson(path.join(partial, "manifest.json"), manifest);
    await chmod(path.join(partial, "report.json"), 0o440);
    await chmod(path.join(partial, "manifest.json"), 0o440);
    await syncDirectory(partial);
    await chmod(partial, 0o550);
    await rename(partial, target);
    await syncDirectory(canonicalOutput);
    return target;
  } catch (error) {
    await chmod(partial, 0o700).catch(() => undefined);
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") throw new Error("V6 result bundle already exists; overwrite is forbidden");
    throw error;
  }
}

export async function verifyV6ConductedBundle(bundlePath: string, witness: V6WitnessContext): Promise<V6BundleVerification> {
  const root = await canonicalDirectory(bundlePath, "V6 result bundle", true);
  const entries = (await readdir(root)).sort();
  if (entries.join("\0") !== ["manifest.json", "report.json"].join("\0")) throw new Error("V6 result bundle has missing or undeclared files");
  const manifest = (await readJson<Record<string, unknown>>(path.join(root, "manifest.json"), MAX_RESULT_BYTES)).value;
  const reportRead = await readJson<V6ConductedReport>(path.join(root, "report.json"), MAX_RESULT_BYTES);
  const report = reportRead.value;
  if (manifest.recordType !== "rf-monitor-v6-result-bundle" || manifest.campaignId !== report.campaignId || manifest.runId !== report.runId || manifest.gateDecision !== report.result.gateDecision || manifest.approvedBindingSha256 !== report.approvedBindingSha256 || manifest.evidenceTreeSha256 !== report.campaign.evidenceTreeSha256) throw new Error("V6 result bundle manifest/report identity mismatch");
  const files = manifest.files;
  if (!Array.isArray(files) || files.length !== 1 || !isRecord(files[0]) || files[0].path !== "report.json" || files[0].sha256 !== reportRead.sha256 || files[0].bytes !== reportRead.bytes.byteLength) throw new Error("V6 result bundle report hash mismatch");
  if (report.recordType !== "rf-monitor-v6-conducted-result" || report.gate !== "V6" || report.result.productionReady !== false || report.counts.failed !== report.cases.filter((score) => !score.passed).length || report.result.gateDecision !== (report.counts.failed === 0 ? "passed" : "failed") || report.deterministicResultHash !== sha256CanonicalV6({ release: report.release, approvedBindingSha256: report.approvedBindingSha256, campaignId: report.campaignId, protocolSha256: report.campaign.protocolSha256, evidenceTreeSha256: report.campaign.evidenceTreeSha256, scores: report.cases, decision: report.result.gateDecision })) throw new Error("V6 result report mechanical integrity failed");
  const key = witnessKey(witness);
  if (report.witness.keySha256 !== key.keySha256 || manifest.witnessKeySha256 !== key.keySha256) throw new Error("V6 result bundle witness key mismatch");
  if (sha256CanonicalV6(report.binding) !== report.approvedBindingSha256
    || !sameCanonical(report.release, report.binding.release)
    || report.witness.protocol.statement.campaignId !== report.campaignId
    || report.witness.protocol.statement.protocolSha256 !== report.campaign.protocolSha256
    || report.witness.protocol.statement.approvedBindingSha256 !== report.approvedBindingSha256
    || report.witness.final.statement.campaignId !== report.campaignId
    || report.witness.final.statement.protocolSha256 !== report.campaign.protocolSha256
    || report.witness.final.statement.evidenceTreeSha256 !== report.campaign.evidenceTreeSha256
    || report.witness.final.statement.declaredResultSha256 !== report.campaign.declaredResultSha256
    || report.witness.final.statement.caseResultSha256 !== v6CaseResultFingerprint(report.cases)
    || report.witness.final.statement.declaredDecision !== report.result.gateDecision
    || report.witness.final.statement.firstExposureAt !== report.campaign.firstExposureAt
    || report.witness.final.statement.lastExposureAt !== report.campaign.lastExposureAt) throw new Error("V6 result bundle is not cryptographically bound to its campaign report");
  verifyWitnessEnvelope(report.witness.protocol, report.witness.protocol.statement, key.key, key.keySha256, "V6 bundled protocol witness");
  verifyWitnessEnvelope(report.witness.final, report.witness.final.statement, key.key, key.keySha256, "V6 bundled final witness");
  return { outcome: "PASS", gateDecision: report.result.gateDecision, campaignId: report.campaignId, reportSha256: reportRead.sha256, witnessKeySha256: key.keySha256 };
}
