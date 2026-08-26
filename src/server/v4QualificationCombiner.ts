import { createHash } from "node:crypto";
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
import path from "node:path";
import {
  verifyV4CampaignBundle,
  type FrozenCandidateIdentity,
} from "./syntheticQualificationCampaign";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+\-]*$/;
const MAX_FILES = 2_048;
const MAX_DIRECTORIES = 64;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TREE_BYTES = 768 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

const PACKAGED_CASES = Object.freeze([
  { caseId: "wideband-l1", scenarioId: "wideband", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "alert" },
  { caseId: "wideband-l2", scenarioId: "wideband", targetId: "gnss-gps-l2c", expectedOutcome: "alert" },
  { caseId: "wideband-l5", scenarioId: "wideband", targetId: "gnss-l5-e5a-b2a", expectedOutcome: "alert" },
  { caseId: "wideband-g1", scenarioId: "wideband", targetId: "gnss-glonass-g1", expectedOutcome: "alert" },
  { caseId: "matched-power-neutral", scenarioId: "matched-power-spoofing", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "no-alert" },
  { caseId: "configuration-change-unknown", scenarioId: "configuration-change", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "unknown" },
  { caseId: "data-gap-unknown", scenarioId: "data-gap", targetId: "gnss-l1-e1-b1c-sbas", expectedOutcome: "unknown" },
]);

const TIER_ONE_TARGETS = Object.freeze([
  "gnss-glonass-g1",
  "gnss-gps-l2c",
  "gnss-l1-e1-b1c-sbas",
  "gnss-l5-e5a-b2a",
]);

interface TreeFile {
  relative: string;
  bytes: number;
  sha256: string;
}

interface TreeSnapshot {
  files: TreeFile[];
  directories: string[];
  fileCount: number;
  bytes: number;
  sha256: string;
}

interface PackagedVerification {
  manifest: Record<string, unknown>;
  report: Record<string, unknown>;
  release: FrozenCandidateIdentity;
  identity: V4CombinedIdentity;
  campaignId: string;
  reportSha256: string;
  snapshot: TreeSnapshot;
}

interface DetectorVerification {
  manifest: Record<string, unknown>;
  report: Record<string, unknown>;
  release: FrozenCandidateIdentity;
  campaignId: string;
  reportSha256: string;
  snapshot: TreeSnapshot;
  targetIds: string[];
  catalogVersion: string;
  catalogSha256: string;
  detectorRuleSetId: string;
  detectorRuleSha256: string;
}

export interface V4CombinedIdentity {
  release: FrozenCandidateIdentity;
  clientBuildId: string;
  configurationSha256: string;
  catalogVersion: string;
  catalogSha256: string;
  detectorRuleSetId: string;
  detectorRuleSha256: string;
  expectedSampleRateHz: 10_000_000;
}

export interface V4CombinerDependencies {
  verifyDetectorBundle?: typeof verifyV4CampaignBundle;
  readCurrentIdentity: () => Promise<V4CombinedIdentity>;
  now?: () => Date;
}

export interface CombineV4Options {
  packagedBundle: string;
  detectorBundle: string;
  outputRoot: string;
  resultId: string;
  dependencies: V4CombinerDependencies;
}

export interface VerifyV4CombinedOptions {
  verifyDetectorBundle?: typeof verifyV4CampaignBundle;
  expectedIdentity?: V4CombinedIdentity;
}

export interface V4CombinedVerification {
  valid: true;
  gateDecision: "passed";
  productionReady: false;
  resultId: string;
  files: number;
  bytes: number;
}

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256CanonicalV4(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return sha256CanonicalV4(left) === sha256CanonicalV4(right);
}

function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_ID_PATTERN.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function normalizeRelease(value: unknown, label: string): FrozenCandidateIdentity {
  assertion(isRecord(value), `${label} is absent`);
  const release: FrozenCandidateIdentity = {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: String(value.releaseVersion ?? ""),
    buildId: String(value.buildId ?? ""),
    sourceDigest: String(value.sourceDigest ?? ""),
    packageDigest: String(value.packageDigest ?? ""),
    dependencyLockDigest: String(value.dependencyLockDigest ?? ""),
  };
  assertText(release.releaseVersion, `${label} releaseVersion`);
  assertText(release.buildId, `${label} buildId`);
  assertHash(release.sourceDigest, `${label} sourceDigest`);
  assertHash(release.packageDigest, `${label} packageDigest`);
  assertHash(release.dependencyLockDigest, `${label} dependencyLockDigest`);
  if (value.schemaVersion !== undefined) assertion(value.schemaVersion === 1, `${label} schemaVersion is invalid`);
  if (value.product !== undefined) assertion(value.product === "rf-monitor", `${label} product is invalid`);
  return release;
}

function validateIdentity(identity: V4CombinedIdentity, label: string): V4CombinedIdentity {
  const release = normalizeRelease(identity.release, `${label} release`);
  assertText(identity.clientBuildId, `${label} clientBuildId`);
  assertion(identity.clientBuildId === release.buildId, `${label} client build does not match the release build`);
  assertHash(identity.configurationSha256, `${label} configurationSha256`);
  assertText(identity.catalogVersion, `${label} catalogVersion`);
  assertHash(identity.catalogSha256, `${label} catalogSha256`);
  assertText(identity.detectorRuleSetId, `${label} detectorRuleSetId`);
  assertHash(identity.detectorRuleSha256, `${label} detectorRuleSha256`);
  assertion(identity.expectedSampleRateHz === 10_000_000, `${label} expectedSampleRateHz is invalid`);
  return { ...identity, release };
}

function safeRelative(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  assertion(normalized.length > 0 && normalized.length <= 512 && SAFE_RELATIVE_PATH_PATTERN.test(normalized), `Unsafe artifact path ${relative}`);
  assertion(!normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0), `Unsafe artifact path ${relative}`);
  return normalized;
}

async function hashOpenFile(filePath: string, expectedMaximum = MAX_FILE_BYTES): Promise<{ bytes: number; sha256: string }> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertion(before.isFile() && before.size >= 0 && before.size <= expectedMaximum, `Artifact ${filePath} exceeds its file bound`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const read = await handle.read(buffer, 0, length, position);
      assertion(read.bytesRead > 0, `Artifact ${filePath} changed while hashing`);
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const after = await handle.stat();
    assertion(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs,
      `Artifact ${filePath} changed while hashing`);
    return { bytes: before.size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function snapshotTree(rootPath: string, limits: { files?: number; directories?: number; bytes?: number } = {}): Promise<TreeSnapshot> {
  const root = path.resolve(rootPath);
  const details = await lstat(root);
  assertion(details.isDirectory() && !details.isSymbolicLink(), `Artifact root ${root} is not a regular directory`);
  assertion(await realpath(root) === root, `Artifact root ${root} uses linked path components`);
  const maximumFiles = limits.files ?? MAX_FILES;
  const maximumDirectories = limits.directories ?? MAX_DIRECTORIES;
  const maximumBytes = limits.bytes ?? MAX_TREE_BYTES;
  const files: TreeFile[] = [];
  const directories: string[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      const relative = safeRelative(current.relative ? `${current.relative}/${entry.name}` : entry.name);
      const absolute = path.join(root, ...relative.split("/"));
      const child = await lstat(absolute);
      assertion(!child.isSymbolicLink(), `Artifact tree contains symlink ${relative}`);
      if (child.isDirectory()) {
        directories.push(relative);
        assertion(directories.length <= maximumDirectories, "Artifact tree exceeds its directory bound");
        pending.push({ absolute, relative });
      } else {
        assertion(child.isFile(), `Artifact tree contains non-regular entry ${relative}`);
        assertion(files.length < maximumFiles, "Artifact tree exceeds its file-count bound");
        const hashed = await hashOpenFile(absolute);
        bytes += hashed.bytes;
        assertion(bytes <= maximumBytes, "Artifact tree exceeds its byte bound");
        files.push({ relative, ...hashed });
      }
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  directories.sort();
  return {
    files,
    directories,
    fileCount: files.length,
    bytes,
    sha256: sha256CanonicalV4({ directories, files }),
  };
}

async function readBoundedJson(filePath: string, label: string): Promise<Record<string, unknown>> {
  const hashed = await hashOpenFile(filePath, MAX_JSON_BYTES);
  assertion(hashed.bytes > 0, `${label} is empty`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const buffer = Buffer.allocUnsafe(hashed.bytes);
    const read = await handle.read(buffer, 0, buffer.byteLength, 0);
    assertion(read.bytesRead === buffer.byteLength, `${label} changed while reading`);
    assertion(sha256(buffer) === hashed.sha256, `${label} changed between verification and parsing`);
    const value = JSON.parse(buffer.toString("utf8")) as unknown;
    assertion(isRecord(value), `${label} must be a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  } finally {
    await handle.close();
  }
}

function fileByName(snapshot: TreeSnapshot, relative: string): TreeFile {
  const file = snapshot.files.find((entry) => entry.relative === relative);
  assertion(file, `Artifact tree is missing ${relative}`);
  return file;
}

async function verifyChecksumManifest(root: string, snapshot: TreeSnapshot, expectedPaths?: string[]): Promise<void> {
  const sumsFile = fileByName(snapshot, "SHA256SUMS");
  assertion(sumsFile.bytes > 0 && sumsFile.bytes <= 1024 * 1024, "SHA256SUMS exceeds its bound");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path.join(root, "SHA256SUMS"), constants.O_RDONLY | noFollow);
  let text: string;
  try {
    const bytes = Buffer.allocUnsafe(sumsFile.bytes);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    assertion(read.bytesRead === bytes.byteLength, "SHA256SUMS changed while reading");
    assertion(sha256(bytes) === sumsFile.sha256, "SHA256SUMS changed between verification and parsing");
    text = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  assertion(text.endsWith("\n"), "SHA256SUMS is not newline terminated");
  const listed = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._/+\-]*)$/.exec(line);
    assertion(match && match[2] !== "SHA256SUMS" && !listed.has(match[2]), "SHA256SUMS contains an invalid, reserved, or duplicate entry");
    listed.set(match[2], match[1]);
  }
  const actual = snapshot.files.filter((file) => file.relative !== "SHA256SUMS");
  const expected = expectedPaths ? [...expectedPaths].sort() : actual.map((file) => file.relative).sort();
  assertion(sameCanonical([...listed.keys()].sort(), expected), "SHA256SUMS does not cover the exact artifact set");
  for (const file of actual) {
    assertion(listed.get(file.relative) === file.sha256, `SHA256SUMS hash mismatch for ${file.relative}`);
  }
}

function exactRootShape(snapshot: TreeSnapshot, files: string[], directories: string[], label: string): void {
  assertion(sameCanonical(snapshot.files.map((entry) => entry.relative).sort(), [...files].sort()), `${label} contains a missing or unexpected file`);
  assertion(sameCanonical(snapshot.directories, [...directories].sort()), `${label} contains a missing or unexpected directory`);
}

function packageCasePassed(value: unknown, expected: (typeof PACKAGED_CASES)[number]): boolean {
  if (!isRecord(value)) return false;
  if (value.caseId !== expected.caseId || value.scenarioId !== expected.scenarioId || value.targetId !== expected.targetId
      || value.expectedOutcome !== expected.expectedOutcome || value.observedOutcome !== expected.expectedOutcome || value.result !== "PASS") return false;
  if (!Array.isArray(value.phases) || !Array.isArray(value.operatorStates)) return false;
  const phases = value.phases;
  const operatorStates = value.operatorStates;
  if (expected.expectedOutcome === "alert") {
    return value.verdict === "Suspected RF interference"
      && ["alert", "recovering", "complete"].every((phase) => phases.includes(phase))
      && ["alert", "recovering"].every((state) => operatorStates.includes(state));
  }
  return !phases.includes("alert") && !phases.includes("recovering")
    && !operatorStates.includes("alert") && !operatorStates.includes("recovering")
    && (expected.expectedOutcome === "unknown" ? value.verdict === "Test inconclusive" : value.verdict === "No RF change detected");
}

/** Independent, pass-only verifier for the packaged V4 sub-gate. */
export async function verifyPassingV4PackagedBundle(bundlePath: string): Promise<PackagedVerification> {
  const root = path.resolve(bundlePath);
  const snapshot = await snapshotTree(root, { files: 3, directories: 0, bytes: 5 * 1024 * 1024 });
  exactRootShape(snapshot, ["SHA256SUMS", "manifest.json", "report.json"], [], "V4 packaged bundle");
  await verifyChecksumManifest(root, snapshot, ["manifest.json", "report.json"]);
  const [manifest, report] = await Promise.all([
    readBoundedJson(path.join(root, "manifest.json"), "V4 packaged manifest"),
    readBoundedJson(path.join(root, "report.json"), "V4 packaged report"),
  ]);
  const manifestFile = fileByName(snapshot, "manifest.json");
  const reportFile = fileByName(snapshot, "report.json");
  assertion(manifest.schemaVersion === 1 && manifest.recordType === "rf-monitor-v4-packaged-end-to-end-manifest"
    && manifest.writtenBeforeScenarioExecution === true, "V4 packaged manifest identity is invalid");
  assertion(isRecord(manifest.identity), "packaged-config-binding-missing");
  const identity = validateIdentity(manifest.identity as unknown as V4CombinedIdentity, "V4 packaged qualification identity");
  assertText(manifest.campaignId, "V4 packaged campaignId");
  assertion(Array.isArray(manifest.cases) && manifest.cases.length === PACKAGED_CASES.length, "V4 packaged case matrix is incomplete");
  const casesWithoutOrder = manifest.cases.map((value) => {
    assertion(isRecord(value), "V4 packaged case commitment is invalid");
    const { schemaVersion: _schemaVersion, order: _order, ...entry } = value;
    return entry;
  });
  assertion(sha256CanonicalV4(casesWithoutOrder) === sha256CanonicalV4(PACKAGED_CASES)
    && manifest.casesHash === sha256CanonicalV4(PACKAGED_CASES), "V4 packaged case commitments changed");
  assertion(Array.isArray(manifest.targetIds)
    && sameCanonical([...manifest.targetIds].sort(), TIER_ONE_TARGETS), "V4 packaged target set is invalid");
  const release = normalizeRelease(manifest.release, "V4 packaged manifest release");
  assertion(sameCanonical(identity.release, release) && identity.catalogVersion === manifest.catalogVersion,
    "V4 packaged qualification identity does not bind its manifest");
  assertion(report.schemaVersion === 1 && report.recordType === "rf-monitor-v4-packaged-end-to-end-result"
    && report.campaignId === manifest.campaignId && report.manifestHash === manifestFile.sha256, "V4 packaged report binding is invalid");
  assertion(isRecord(report.release) && report.release.unchanged === true
    && sameCanonical(normalizeRelease(report.release.before, "V4 packaged release before"), release)
    && sameCanonical(normalizeRelease(report.release.after, "V4 packaged release after"), release), "V4 packaged release changed");
  assertion(isRecord(report.result) && report.result.packagedEndToEndSubGate === "passed"
    && report.result.overallV4 === "not-passed" && report.result.productionReady === false, "V4 packaged sub-gate did not pass independently");
  assertion(Array.isArray(report.cases) && report.cases.length === PACKAGED_CASES.length
    && report.cases.every((value, index) => packageCasePassed(value, PACKAGED_CASES[index])), "V4 packaged passing cases are incomplete or invalid");
  assertion(isRecord(report.runtime) && report.runtime.simulation === true && report.runtime.physicalReceiver === "not-run", "V4 packaged result is not synthetic software evidence");
  assertion(sameCanonical(report.qualificationIdentity, identity) && isRecord(report.runtimeIdentity)
    && report.runtimeIdentity.unchanged === true && sameCanonical(report.runtimeIdentity.before, report.runtimeIdentity.after)
    && isRecord(report.loadedQualificationIdentity) && report.loadedQualificationIdentity.unchanged === true
    && sameCanonical(report.loadedQualificationIdentity.before, identity) && sameCanonical(report.loadedQualificationIdentity.after, identity),
  "V4 packaged result lacks an unchanged runtime configuration binding");
  const expectedRuntimeIdentity = {
    release: identity.release,
    clientBuildId: identity.clientBuildId,
    configurationSha256: identity.configurationSha256,
    catalogVersion: identity.catalogVersion,
    detectorRuleSetId: identity.detectorRuleSetId,
    expectedSampleRateHz: 10_000_000,
  };
  assertion(sameCanonical(report.runtimeIdentity.before, expectedRuntimeIdentity), "V4 packaged runtime did not load its precommitted configuration");
  assertion(isRecord(report.isolation) && report.isolation.executionDomain === "test" && report.isolation.fieldUnchanged === true
    && report.isolation.testChanged === true, "V4 packaged domain isolation did not pass");
  assertion(isRecord(report.evidence) && isRecord(report.evidence.attribution)
    && report.evidence.attribution.oldFrequencyMisattribution === 0
    && Number(report.evidence.attribution.syntheticFramesPersisted) > 0, "V4 packaged evidence attribution did not pass");
  assertion(isRecord(report.downstreamGates) && report.downstreamGates.V5 === "not-run"
    && report.downstreamGates.V6 === "not-run" && report.downstreamGates.V7 === "not-run", "V4 packaged downstream gates are not fail-closed");
  return {
    manifest,
    report,
    release,
    identity,
    campaignId: manifest.campaignId,
    reportSha256: reportFile.sha256,
    snapshot,
  };
}

async function verifyPassingDetectorBundle(bundlePath: string, verifier: typeof verifyV4CampaignBundle): Promise<DetectorVerification> {
  await verifier(bundlePath);
  const root = path.resolve(bundlePath);
  const snapshot = await snapshotTree(root, { files: 1_024, directories: 2, bytes: 512 * 1024 * 1024 });
  const [manifest, report] = await Promise.all([
    readBoundedJson(path.join(root, "manifest.json"), "V4 detector manifest"),
    readBoundedJson(path.join(root, "report.json"), "V4 detector report"),
  ]);
  const reportFile = fileByName(snapshot, "report.json");
  assertion(manifest.schemaVersion === 1 && manifest.recordType === "rf-monitor-v4-detector-campaign"
    && manifest.overallV4Eligible === false && isRecord(manifest.frozen) && isRecord(manifest.counts)
    && isRecord(manifest.protocol), "V4 detector manifest identity is invalid");
  assertText(manifest.campaignId, "V4 detector campaignId");
  const release = normalizeRelease(manifest.release, "V4 detector manifest release");
  assertion(manifest.counts.total === 16_040 && manifest.counts.deterministic === 40 && manifest.counts.randomized === 16_000
    && manifest.protocol.deterministicRunsPerTargetFamily === 1 && manifest.protocol.randomizedRunsPerTargetFamily === 400,
  "V4 detector campaign is not the complete 16,040-case protocol");
  assertion(Array.isArray(manifest.frozen.targetIds) && sameCanonical([...manifest.frozen.targetIds].sort(), TIER_ONE_TARGETS), "V4 detector target set is invalid");
  assertText(manifest.frozen.catalogVersion, "V4 detector catalogVersion");
  assertHash(manifest.frozen.catalogHash, "V4 detector catalogHash");
  assertText(manifest.frozen.detectorRuleSetId, "V4 detector ruleSetId");
  assertHash(manifest.frozen.detectorRuleHash, "V4 detector ruleHash");
  assertion(report.schemaVersion === 1 && report.recordType === "rf-monitor-v4-detector-campaign-result"
    && report.campaignId === manifest.campaignId && report.executedCases === 16_040 && report.truthCommitmentsVerified === 16_040,
  "V4 detector result is incomplete");
  assertion(isRecord(report.candidate) && report.candidate.unchanged === true && report.candidate.runtimeMatches === true
    && sameCanonical(normalizeRelease(report.candidate.before, "V4 detector release before"), release)
    && sameCanonical(normalizeRelease(report.candidate.after, "V4 detector release after"), release), "V4 detector candidate changed");
  assertion(isRecord(report.result) && report.result.detectorStatisticalSubGate === "passed"
    && report.result.overallV4 === "not-passed" && report.result.productionReady === false, "V4 detector sub-gate did not pass independently");
  assertion(isRecord(report.isolation) && report.isolation.executionDomain === "test"
    && report.isolation.fieldWritesReported === 0 && report.isolation.unchanged === true, "V4 detector domain isolation did not pass");
  assertion(isRecord(report.downstreamGates) && report.downstreamGates.V5 === "not-run" && report.downstreamGates.V6 === "not-run",
    "V4 detector downstream gates are not fail-closed");
  return {
    manifest,
    report,
    release,
    campaignId: manifest.campaignId,
    reportSha256: reportFile.sha256,
    snapshot,
    targetIds: [...manifest.frozen.targetIds] as string[],
    catalogVersion: manifest.frozen.catalogVersion,
    catalogSha256: manifest.frozen.catalogHash,
    detectorRuleSetId: manifest.frozen.detectorRuleSetId,
    detectorRuleSha256: manifest.frozen.detectorRuleHash,
  };
}

function verifyCrossIdentity(packaged: PackagedVerification, detector: DetectorVerification, identityInput: V4CombinedIdentity): V4CombinedIdentity {
  const identity = validateIdentity(identityInput, "V4 current identity");
  assertion(sameCanonical(packaged.release, detector.release) && sameCanonical(packaged.release, identity.release),
    "V4 sub-gates do not bind the same candidate/source/package/dependency-lock identity");
  assertion(identity.clientBuildId === packaged.release.buildId, "V4 client build does not match both sub-gate package identities");
  assertion(sameCanonical(packaged.identity, identity), "V4 packaged sub-gate configuration binding differs from the requested combined identity");
  assertion(packaged.manifest.catalogVersion === detector.catalogVersion && detector.catalogVersion === identity.catalogVersion,
    "V4 sub-gates do not bind the same catalog version");
  assertion(detector.catalogSha256 === identity.catalogSha256, "V4 detector catalog does not match the exact current catalog");
  assertion(detector.detectorRuleSetId === identity.detectorRuleSetId && detector.detectorRuleSha256 === identity.detectorRuleSha256,
    "V4 detector identity does not match the exact validated configuration");
  assertion(sameCanonical([...packaged.manifest.targetIds as unknown[]].sort(), [...detector.targetIds].sort()),
    "V4 sub-gates do not cover the same physical target set");
  return identity;
}

async function copyRegularFile(source: string, destination: string, expected: TreeFile): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    destinationHandle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o440);
    const before = await sourceHandle.stat();
    assertion(before.isFile() && before.size === expected.bytes, `Source artifact changed before copy: ${expected.relative}`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const read = await sourceHandle.read(buffer, 0, length, position);
      assertion(read.bytesRead > 0, `Source artifact changed during copy: ${expected.relative}`);
      const chunk = buffer.subarray(0, read.bytesRead);
      digest.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await destinationHandle.write(chunk, written, chunk.byteLength - written, position + written);
        assertion(result.bytesWritten > 0, `Destination artifact could not be written: ${expected.relative}`);
        written += result.bytesWritten;
      }
      position += chunk.byteLength;
    }
    const after = await sourceHandle.stat();
    assertion(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs
      && digest.digest("hex") === expected.sha256, `Source artifact changed during copy: ${expected.relative}`);
    await destinationHandle.sync();
  } finally {
    await Promise.all([sourceHandle.close(), destinationHandle?.close()]);
  }
}

async function copySnapshot(sourceRoot: string, destinationRoot: string, snapshot: TreeSnapshot): Promise<TreeSnapshot> {
  await mkdir(destinationRoot, { mode: 0o750 });
  for (const directory of [...snapshot.directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    await mkdir(path.join(destinationRoot, ...directory.split("/")), { mode: 0o750 });
  }
  for (const file of snapshot.files) {
    await copyRegularFile(
      path.join(sourceRoot, ...file.relative.split("/")),
      path.join(destinationRoot, ...file.relative.split("/")),
      file,
    );
  }
  const copied = await snapshotTree(destinationRoot);
  assertion(copied.sha256 === snapshot.sha256, "Copied V4 sub-gate bundle differs from its verified source");
  return copied;
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  assertion(Buffer.byteLength(contents) <= MAX_JSON_BYTES, `${path.basename(filePath)} exceeds its byte bound`);
  const handle = await open(filePath, "wx", 0o440);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function sealTree(root: string): Promise<void> {
  const snapshot = await snapshotTree(root);
  for (const file of snapshot.files) await chmod(path.join(root, ...file.relative.split("/")), 0o440);
  for (const directory of [...snapshot.directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
    await chmod(path.join(root, ...directory.split("/")), 0o550);
  }
  await chmod(root, 0o550);
}

async function makeTreeRemovable(root: string): Promise<void> {
  let snapshot: TreeSnapshot;
  try { snapshot = await snapshotTree(root); } catch { return; }
  await chmod(root, 0o750).catch(() => undefined);
  for (const directory of [...snapshot.directories].sort((left, right) => left.split("/").length - right.split("/").length)) {
    await chmod(path.join(root, ...directory.split("/")), 0o750).catch(() => undefined);
  }
  for (const file of snapshot.files) await chmod(path.join(root, ...file.relative.split("/")), 0o640).catch(() => undefined);
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  const forward = path.relative(left, right);
  const reverse = path.relative(right, left);
  return forward === "" || (!forward.startsWith("..") && !path.isAbsolute(forward)) || (!reverse.startsWith("..") && !path.isAbsolute(reverse));
}

function expectedSourceSet(packaged: PackagedVerification, detector: DetectorVerification): string {
  return sha256CanonicalV4({
    packaged: { bundleSha256: packaged.snapshot.sha256, reportSha256: packaged.reportSha256 },
    detector: { bundleSha256: detector.snapshot.sha256, reportSha256: detector.reportSha256 },
  });
}

/** Verifies the complete self-contained overall V4 bundle and both nested sub-gates. */
export async function verifyV4CombinedBundle(bundlePath: string, options: VerifyV4CombinedOptions = {}): Promise<V4CombinedVerification> {
  const root = path.resolve(bundlePath);
  const snapshot = await snapshotTree(root);
  const rootFiles = snapshot.files.filter((file) => !file.relative.includes("/")).map((file) => file.relative).sort();
  const rootDirectories = snapshot.directories.filter((directory) => !directory.includes("/"));
  assertion(sameCanonical(rootFiles, ["SHA256SUMS", "manifest.json", "report.json"])
    && sameCanonical(rootDirectories, ["subgates"])
    && snapshot.directories.includes("subgates/packaged") && snapshot.directories.includes("subgates/detector"),
  "V4 combined bundle root shape is invalid");
  await verifyChecksumManifest(root, snapshot);
  const packagedPath = path.join(root, "subgates", "packaged");
  const detectorPath = path.join(root, "subgates", "detector");
  const [packaged, detector, manifest, report] = await Promise.all([
    verifyPassingV4PackagedBundle(packagedPath),
    verifyPassingDetectorBundle(detectorPath, options.verifyDetectorBundle ?? verifyV4CampaignBundle),
    readBoundedJson(path.join(root, "manifest.json"), "V4 combined manifest"),
    readBoundedJson(path.join(root, "report.json"), "V4 combined report"),
  ]);
  assertion(manifest.schemaVersion === 1 && manifest.recordType === "rf-monitor-v4-combined-manifest" && manifest.gate === "V4"
    && manifest.syntheticSoftwareEvidenceOnly === true && manifest.productionReady === false && manifest.resultId === report.resultId,
  "V4 combined manifest identity is invalid");
  assertion(typeof manifest.completedAt === "string" && Number.isFinite(Date.parse(manifest.completedAt))
    && isRecord(manifest.publication) && manifest.publication.noOverwrite === true
    && manifest.publication.atomicDirectoryRename === true && manifest.publication.exactChecksumCoverage === true
    && manifest.publication.sourceBundlesReverifiedAfterCopy === true, "V4 combined publication contract is invalid");
  assertText(manifest.resultId, "V4 combined resultId");
  const identity = validateIdentity(manifest.identity as unknown as V4CombinedIdentity, "V4 combined identity");
  verifyCrossIdentity(packaged, detector, identity);
  if (options.expectedIdentity) assertion(sameCanonical(identity, validateIdentity(options.expectedIdentity, "Expected V4 identity")), "V4 combined identity is stale");
  assertion(isRecord(manifest.subgates) && isRecord(manifest.subgates.packaged) && isRecord(manifest.subgates.detector), "V4 combined sub-gate bindings are absent");
  assertion(manifest.subgates.packaged.directory === "subgates/packaged"
    && manifest.subgates.packaged.bundleSha256 === packaged.snapshot.sha256
    && manifest.subgates.packaged.reportSha256 === packaged.reportSha256
    && manifest.subgates.packaged.campaignId === packaged.campaignId
    && manifest.subgates.detector.directory === "subgates/detector"
    && manifest.subgates.detector.bundleSha256 === detector.snapshot.sha256
    && manifest.subgates.detector.reportSha256 === detector.reportSha256
    && manifest.subgates.detector.campaignId === detector.campaignId,
  "V4 combined sub-gate hashes do not bind the nested bundles");
  const sourceSetSha256 = expectedSourceSet(packaged, detector);
  assertion(manifest.sourceSetSha256 === sourceSetSha256, "V4 combined source-set hash is invalid");
  const manifestFile = fileByName(snapshot, "manifest.json");
  assertion(report.schemaVersion === 1 && report.recordType === "rf-monitor-v4-combined-result" && report.gate === "V4"
    && report.resultId === manifest.resultId && report.completedAt === manifest.completedAt && report.manifestSha256 === manifestFile.sha256,
  "V4 combined report binding is invalid");
  assertion(sameCanonical(normalizeRelease(report.release, "V4 combined report release"), identity.release)
    && report.clientBuildId === identity.clientBuildId && report.configurationSha256 === identity.configurationSha256
    && report.catalogVersion === identity.catalogVersion && report.catalogSha256 === identity.catalogSha256
    && report.detectorRuleSetId === identity.detectorRuleSetId && report.detectorRuleSha256 === identity.detectorRuleSha256
    && report.expectedSampleRateHz === identity.expectedSampleRateHz,
  "V4 combined report identity differs from its manifest");
  assertion(report.packagedBundleSha256 === packaged.snapshot.sha256 && report.detectorBundleSha256 === detector.snapshot.sha256
    && report.packagedResultSha256 === packaged.reportSha256 && report.detectorResultSha256 === detector.reportSha256
    && report.sourceSetSha256 === sourceSetSha256 && report.detectorCases === 16_040,
  "V4 combined report does not bind both exact verified sub-gates");
  assertion(isRecord(report.result) && report.result.packagedEndToEndSubGate === "passed"
    && report.result.detectorStatisticalSubGate === "passed" && report.result.gateDecision === "passed"
    && report.result.softwareQualificationOnly === true && report.result.productionReady === false
    && report.result.V5 === "not-run" && report.result.V6 === "not-run" && report.result.V7 === "not-run",
  "V4 combined decision is not fail-closed");
  assertion(report.releaseUnchanged === true && report.sourceBundlesUnchanged === true
    && Array.isArray(report.limitations) && report.limitations.length >= 3
    && report.limitations.some((value) => typeof value === "string" && /synthetic software evidence only/i.test(value))
    && report.limitations.some((value) => typeof value === "string" && /live field-domain V5, V6.*24-hour V7/i.test(value)),
  "V4 combined report lacks drift or scope limits");
  return {
    valid: true,
    gateDecision: "passed",
    productionReady: false,
    resultId: manifest.resultId,
    files: snapshot.fileCount,
    bytes: snapshot.bytes,
  };
}

/** Combines two already-passing exact-candidate V4 sub-gates; it never runs either sub-gate. */
export async function combineV4Qualification(options: CombineV4Options): Promise<{ bundlePath: string; verification: V4CombinedVerification }> {
  const packagedRoot = path.resolve(options.packagedBundle);
  const detectorRoot = path.resolve(options.detectorBundle);
  const outputRoot = path.resolve(options.outputRoot);
  const resultId = safeId(options.resultId, "V4 combined result id");
  assertion(packagedRoot !== detectorRoot && !pathsOverlap(packagedRoot, detectorRoot), "V4 sub-gate bundle roots must be separate");
  assertion(outputRoot !== path.parse(outputRoot).root && !pathsOverlap(outputRoot, packagedRoot) && !pathsOverlap(outputRoot, detectorRoot),
    "V4 output root must be separate from both sub-gate bundles");
  await mkdir(outputRoot, { recursive: true, mode: 0o750 });
  assertion(await realpath(outputRoot) === outputRoot, "V4 output root uses linked path components");
  const finalPath = path.join(outputRoot, resultId);
  const partialPath = path.join(outputRoot, `.partial-${resultId}-${process.pid}`);
  const lockPath = path.join(outputRoot, ".v4-combine.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Another V4 combine operation or retained crash lock exists");
    throw error;
  });
  try {
    assertion(!await lstat(finalPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)),
      "V4 combined result already exists and will not be overwritten");
    assertion(!await lstat(partialPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error)),
      "V4 combined partial path already exists");
    const verifier = options.dependencies.verifyDetectorBundle ?? verifyV4CampaignBundle;
    const identityBefore = validateIdentity(await options.dependencies.readCurrentIdentity(), "Initial V4 identity");
    const [packagedBefore, detectorBefore] = await Promise.all([
      verifyPassingV4PackagedBundle(packagedRoot),
      verifyPassingDetectorBundle(detectorRoot, verifier),
    ]);
    const identity = verifyCrossIdentity(packagedBefore, detectorBefore, identityBefore);
    await mkdir(partialPath, { mode: 0o750 });
    await mkdir(path.join(partialPath, "subgates"), { mode: 0o750 });
    const [packagedCopy, detectorCopy] = await Promise.all([
      copySnapshot(packagedRoot, path.join(partialPath, "subgates", "packaged"), packagedBefore.snapshot),
      copySnapshot(detectorRoot, path.join(partialPath, "subgates", "detector"), detectorBefore.snapshot),
    ]);
    assertion(packagedCopy.sha256 === packagedBefore.snapshot.sha256 && detectorCopy.sha256 === detectorBefore.snapshot.sha256,
      "V4 sub-gate copy verification failed");
    const [packagedCopied, detectorCopied, packagedAfterCopy, detectorAfterCopy, identityAfterCopy] = await Promise.all([
      verifyPassingV4PackagedBundle(path.join(partialPath, "subgates", "packaged")),
      verifyPassingDetectorBundle(path.join(partialPath, "subgates", "detector"), verifier),
      snapshotTree(packagedRoot),
      snapshotTree(detectorRoot),
      options.dependencies.readCurrentIdentity().then((value) => validateIdentity(value, "Post-copy V4 identity")),
    ]);
    assertion(packagedAfterCopy.sha256 === packagedBefore.snapshot.sha256 && detectorAfterCopy.sha256 === detectorBefore.snapshot.sha256,
      "A V4 source bundle changed during combination");
    assertion(sameCanonical(identityAfterCopy, identity), "V4 source/package/configuration identity changed during combination");
    verifyCrossIdentity(packagedCopied, detectorCopied, identity);
    const sourceSetSha256 = expectedSourceSet(packagedCopied, detectorCopied);
    const completedAt = (options.dependencies.now ?? (() => new Date()))().toISOString();
    assertion(Number.isFinite(Date.parse(completedAt)), "V4 completion time is invalid");
    const manifest = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-combined-manifest",
      gate: "V4",
      resultId,
      completedAt,
      identity,
      syntheticSoftwareEvidenceOnly: true,
      productionReady: false,
      subgates: {
        packaged: {
          directory: "subgates/packaged",
          campaignId: packagedCopied.campaignId,
          bundleSha256: packagedCopied.snapshot.sha256,
          reportSha256: packagedCopied.reportSha256,
        },
        detector: {
          directory: "subgates/detector",
          campaignId: detectorCopied.campaignId,
          bundleSha256: detectorCopied.snapshot.sha256,
          reportSha256: detectorCopied.reportSha256,
        },
      },
      sourceSetSha256,
      publication: {
        noOverwrite: true,
        atomicDirectoryRename: true,
        exactChecksumCoverage: true,
        sourceBundlesReverifiedAfterCopy: true,
      },
    };
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeExclusive(path.join(partialPath, "manifest.json"), manifestContents);
    const report = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-combined-result",
      gate: "V4",
      resultId,
      completedAt,
      manifestSha256: sha256(manifestContents),
      release: identity.release,
      clientBuildId: identity.clientBuildId,
      configurationSha256: identity.configurationSha256,
      catalogVersion: identity.catalogVersion,
      catalogSha256: identity.catalogSha256,
      detectorRuleSetId: identity.detectorRuleSetId,
      detectorRuleSha256: identity.detectorRuleSha256,
      expectedSampleRateHz: identity.expectedSampleRateHz,
      packagedBundleSha256: packagedCopied.snapshot.sha256,
      detectorBundleSha256: detectorCopied.snapshot.sha256,
      packagedResultSha256: packagedCopied.reportSha256,
      detectorResultSha256: detectorCopied.reportSha256,
      sourceSetSha256,
      detectorCases: 16_040,
      releaseUnchanged: true,
      sourceBundlesUnchanged: true,
      result: {
        packagedEndToEndSubGate: "passed",
        detectorStatisticalSubGate: "passed",
        gateDecision: "passed",
        softwareQualificationOnly: true,
        productionReady: false,
        V5: "not-run",
        V6: "not-run",
        V7: "not-run",
      },
      limitations: [
        "V4 uses generated normalized FFT data in the isolated test domain; it is synthetic software evidence only.",
        "V4 cannot qualify a live RSPdx/RSPdx R2, SDRconnect, antenna, installed RF chain, field baseline, or production site.",
        "Production readiness requires separate live field-domain V5, V6, and bounded 24-hour V7 evidence; simulation can never satisfy those gates.",
      ],
    };
    await writeExclusive(path.join(partialPath, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    const withoutSums = await snapshotTree(partialPath);
    assertion(!withoutSums.files.some((file) => file.relative === "SHA256SUMS"), "V4 partial bundle already contains SHA256SUMS");
    const sums = `${withoutSums.files.map((file) => `${file.sha256}  ${file.relative}`).join("\n")}\n`;
    await writeExclusive(path.join(partialPath, "SHA256SUMS"), sums);
    await syncDirectory(path.join(partialPath, "subgates", "packaged"));
    await syncDirectory(path.join(partialPath, "subgates", "detector", "results"));
    await syncDirectory(path.join(partialPath, "subgates", "detector"));
    await syncDirectory(path.join(partialPath, "subgates"));
    await syncDirectory(partialPath);
    await verifyV4CombinedBundle(partialPath, { verifyDetectorBundle: verifier, expectedIdentity: identity });
    const [packagedBeforePublish, detectorBeforePublish, identityBeforePublish] = await Promise.all([
      snapshotTree(packagedRoot),
      snapshotTree(detectorRoot),
      options.dependencies.readCurrentIdentity().then((value) => validateIdentity(value, "Pre-publication V4 identity")),
    ]);
    assertion(packagedBeforePublish.sha256 === packagedBefore.snapshot.sha256 && detectorBeforePublish.sha256 === detectorBefore.snapshot.sha256,
      "A V4 source bundle changed before publication");
    assertion(sameCanonical(identityBeforePublish, identity), "V4 source/package/configuration drift occurred before publication");
    await sealTree(partialPath);
    await rename(partialPath, finalPath);
    await syncDirectory(outputRoot);
    const verification = await verifyV4CombinedBundle(finalPath, { verifyDetectorBundle: verifier, expectedIdentity: identity });
    return { bundlePath: finalPath, verification };
  } catch (error) {
    await makeTreeRemovable(partialPath);
    await rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
