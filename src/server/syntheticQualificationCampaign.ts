import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
} from "../../scripts/release-digest-policy.mjs";
import { DEFAULT_THRESHOLDS, detectionRuleFingerprint, type DetectionThresholds } from "../shared/detection";
import {
  DETECTOR_QUALIFICATION_PLAN_VERSION,
  detectorQualificationPlan,
} from "../shared/detectorQualification";
import type {
  BinomialConfidenceInterval,
  SyntheticEventKind,
  SyntheticExpectedOutcome,
  SyntheticScenarioDefinition,
  ValidationEventVerdict,
} from "../shared/syntheticValidation";
import type { BandCatalog } from "../shared/types";
import {
  binomialWilsonOneSidedInterval,
  createRandomizedSyntheticScenario,
  createResearchSyntheticScenarioSuite,
  detectorQualificationTrialSeed,
  sha256Canonical,
} from "./syntheticValidation";
import {
  prepareSyntheticQualificationDefinition,
  runSyntheticQualificationDefinition,
  type SyntheticQualificationReport,
  type SyntheticQualificationRunnerOptions,
} from "./syntheticQualificationRunner";

export const V4_DETECTOR_CAMPAIGN_SCHEMA_VERSION = 1 as const;
export const V4_DETECTOR_CAMPAIGN_VERSION = "rf-v4-conditional-detector-1.0.0" as const;

const RANDOMIZED_RUNS_PER_TARGET_FAMILY = 400;
const CONFIDENCE = 0.95;
const REQUIRED_LOWER_LIMIT = 0.99;
const MAX_CASES = 20_000;
const DEFAULT_CHUNK_CASES = 50;
const MAX_COMMITMENTS_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_PROTECTED_TREE_ENTRIES = 100_000;
const MAX_PROTECTED_TREE_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const FAMILIES: SyntheticEventKind[] = [
  "sham",
  "wideband",
  "pulsed-wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
  "configuration-change",
  "data-gap",
  "matched-power-spoofing",
];

const ALERT_FAMILIES = new Set<SyntheticEventKind>([
  "wideband",
  "pulsed-wideband",
  "cw",
  "multitone",
  "moving-narrowband",
  "overload",
]);
const NEGATIVE_CONTROL_FAMILIES = new Set<SyntheticEventKind>(["sham", "matched-power-spoofing"]);
const UNKNOWN_CONTROL_FAMILIES = new Set<SyntheticEventKind>(["configuration-change", "data-gap"]);

export interface FrozenCandidateIdentity {
  schemaVersion: 1;
  product: "rf-monitor";
  releaseVersion: string;
  buildId: string;
  sourceDigest: string;
  packageDigest: string;
  dependencyLockDigest: string;
}

export interface ProtectedTreeSnapshot {
  state: "absent" | "verified" | "bound-exceeded";
  root: string;
  entries: number;
  bytes: number;
  sha256?: string;
  reason?: string;
}

export interface V4CampaignCommitment {
  schemaVersion: 1;
  order: number;
  caseId: string;
  level: "isolated-deterministic" | "isolated-randomized";
  targetId: string;
  family: SyntheticEventKind;
  trialIndex: number;
  runId: string;
  seed: string;
  expectedOutcome: SyntheticExpectedOutcome;
  scenario: SyntheticScenarioDefinition;
  scenarioHash: string;
  truthCommitment: string;
  artifactHashes: {
    softwareBuildHash: string;
    configurationHash: string;
    ruleSetHash: string;
    baselineHash: string;
  };
}

export interface V4CampaignManifest {
  schemaVersion: typeof V4_DETECTOR_CAMPAIGN_SCHEMA_VERSION;
  recordType: "rf-monitor-v4-detector-campaign";
  campaignVersion: typeof V4_DETECTOR_CAMPAIGN_VERSION;
  campaignId: string;
  createdAt: string;
  scope: "conditional-detector-statistical-sub-gate";
  overallV4Eligible: false;
  release: FrozenCandidateIdentity;
  runtime: { executable: string; version: string };
  frozen: {
    planVersion: typeof DETECTOR_QUALIFICATION_PLAN_VERSION;
    planHash: string;
    catalogVersion: string;
    catalogHash: string;
    targetIds: string[];
    families: SyntheticEventKind[];
    detectorRuleSetId: string;
    detectorRuleHash: string;
  };
  protocol: {
    deterministicRunsPerTargetFamily: 1;
    randomizedRunsPerTargetFamily: number;
    confidence: typeof CONFIDENCE;
    requiredLowerLimit: typeof REQUIRED_LOWER_LIMIT;
    scoringUnit: "independent-run";
    executionPath: "generated FFT -> visit median -> DetectionEngine -> isolated scorer";
  };
  counts: {
    targets: number;
    families: number;
    deterministic: number;
    randomized: number;
    total: number;
  };
  commitments: {
    file: "commitments.jsonl";
    lines: number;
    bytes: number;
    sha256: string;
    writtenBeforeDetectorExecution: true;
  };
  isolationBefore: ProtectedTreeSnapshot;
  bounds: {
    maximumCases: typeof MAX_CASES;
    resultChunkCases: number;
    maximumCommitmentsBytes: typeof MAX_COMMITMENTS_BYTES;
    maximumChunkBytes: typeof MAX_CHUNK_BYTES;
    maximumProtectedTreeEntries: typeof MAX_PROTECTED_TREE_ENTRIES;
    maximumProtectedTreeBytes: typeof MAX_PROTECTED_TREE_BYTES;
  };
  blockersOutsideThisSubGate: string[];
}

export interface V4CampaignRunRecord {
  schemaVersion: 1;
  order: number;
  caseId: string;
  level: V4CampaignCommitment["level"];
  targetId: string;
  family: SyntheticEventKind;
  trialIndex: number;
  seed: string;
  scenarioHash: string;
  truthCommitment: string;
  truthVerified: boolean;
  expectedOutcome: SyntheticExpectedOutcome;
  observedOutcome: "alert" | "no-alert" | "unknown";
  alertKinds: string[];
  verdict: ValidationEventVerdict;
  detected: boolean;
  missed: boolean;
  correctNonDetection: boolean;
  unknownObserved: boolean;
  unexpectedAlerts: number;
  falseAlertDurationMs: number;
  observedEventExposureMs?: number;
  wallClockLatencyMs?: number;
  observedExposureToAlertMs?: number;
  unobservedLatencyToAlertMs?: number;
  overloadSeparated: boolean;
  dataDomain: "test";
  fieldWrites: 0;
  scorePassed: boolean;
  reportHash: string;
}

interface V4ResultChunk {
  schemaVersion: 1;
  chunkIndex: number;
  firstOrder: number;
  lastOrder: number;
  recordCount: number;
  recordsHash: string;
  records: V4CampaignRunRecord[];
}

export interface V4TargetFamilyResult {
  targetId: string;
  family: SyntheticEventKind;
  expectedOutcome: SyntheticExpectedOutcome;
  deterministic: { runs: number; passed: number; failed: number };
  randomized: {
    runs: number;
    successes: number;
    failures: number;
    interval: BinomialConfidenceInterval | null;
    criterion: "detection" | "alert-free" | "unknown-observed";
    passed: boolean;
  };
  detections: number;
  misses: number;
  falseAlerts: number;
  falseAlertDurationMs: number;
  latency: {
    wallClockMs: V4LatencySummary;
    observedExposureMs: V4LatencySummary;
    unobservedMs: V4LatencySummary;
  };
}

export interface V4LatencySummary {
  samples: number;
  minimumMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maximumMs?: number;
}

export interface V4CampaignReport {
  schemaVersion: 1;
  recordType: "rf-monitor-v4-detector-campaign-result";
  campaignId: string;
  completedAt: string;
  manifestHash: string;
  commitmentsHash: string;
  executedCases: number;
  truthCommitmentsVerified: number;
  outcomes: V4TargetFamilyResult[];
  totals: {
    detections: number;
    misses: number;
    falseAlerts: number;
    falseAlertDurationMs: number;
    unknownExpected: number;
    unknownObserved: number;
  };
  isolation: {
    executionDomain: "test";
    fieldPersistenceDependency: "none";
    fieldWritesReported: 0;
    before: ProtectedTreeSnapshot;
    after: ProtectedTreeSnapshot;
    unchanged: boolean;
  };
  candidate: {
    before: FrozenCandidateIdentity;
    after: FrozenCandidateIdentity;
    unchanged: boolean;
    runtimeExecutable: string;
    runtimeMatches: boolean;
  };
  result: {
    deterministicFixturesPassed: boolean;
    randomizedStatisticalCriteriaPassed: boolean;
    isolationPassed: boolean;
    candidateStayedFrozen: boolean;
    detectorStatisticalSubGate: "passed" | "failed";
    overallV4: "not-passed";
    productionReady: false;
  };
  remainingV4Blockers: string[];
  downstreamGates: { V5: "not-run"; V6: "not-run" };
  limitations: string[];
}

export interface V4CampaignExecutionOptions {
  repositoryRoot: string;
  outputRoot: string;
  campaignId: string;
  catalog: BandCatalog;
  candidate: FrozenCandidateIdentity;
  readCandidate: () => Promise<FrozenCandidateIdentity>;
  protectedFieldRoot: string;
  thresholds?: DetectionThresholds;
  now?: () => Date;
  chunkCases?: number;
  /** Bounded pause seam used for interruption/resume tests. */
  maxNewCases?: number;
  /** Test-only lower count can never pass the frozen >=400 criterion. */
  randomizedRunsPerTargetFamily?: number;
  onProgress?: (completedCases: number, totalCases: number) => void;
}

export interface V4CampaignExecutionResult {
  state: "paused" | "complete";
  bundlePath: string;
  completedCases: number;
  totalCases: number;
  report?: V4CampaignReport;
}

function safeCampaignId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,160}$/.test(value)) throw new Error("V4 campaign id is invalid");
  return value;
}

function stableRunId(campaignId: string, level: V4CampaignCommitment["level"], targetId: string, family: SyntheticEventKind, trialIndex: number): string {
  return `v4-${sha256Canonical({ campaignId, level, targetId, family, trialIndex }).slice(0, 48)}`;
}

function deterministicScenario(catalog: BandCatalog, targetId: string, family: SyntheticEventKind): SyntheticScenarioDefinition {
  const seed = detectorQualificationTrialSeed(catalog, targetId, family, 0);
  const selected = createResearchSyntheticScenarioSuite({
    seedPrefix: seed,
    target: { id: targetId, binCount: 512, baselineLevel: 32, noiseAmplitudeBins: 2, rippleAmplitudeBins: 2 },
  }).find((scenario) => scenario.events[0]?.kind === family);
  if (!selected) throw new Error(`No deterministic scenario exists for ${family}`);
  selected.id = `deterministic-${family}-${targetId}`;
  selected.name = `Deterministic ${family}`;
  selected.seed = seed;
  return selected;
}

function expectedOutcome(scenario: SyntheticScenarioDefinition): SyntheticExpectedOutcome {
  const outcome = scenario.events[0]?.expected.outcome;
  if (!outcome) throw new Error(`Scenario ${scenario.id} has no truth event`);
  return outcome;
}

function prepareCommitment(input: {
  order: number;
  campaignId: string;
  level: V4CampaignCommitment["level"];
  targetId: string;
  family: SyntheticEventKind;
  trialIndex: number;
  scenario: SyntheticScenarioDefinition;
  runnerOptions: SyntheticQualificationRunnerOptions;
}): V4CampaignCommitment {
  const runId = stableRunId(input.campaignId, input.level, input.targetId, input.family, input.trialIndex);
  const prepared = prepareSyntheticQualificationDefinition(input.scenario, "blinded", { ...input.runnerOptions, runId });
  return {
    schemaVersion: 1,
    order: input.order,
    caseId: `${input.level}:${input.targetId}:${input.family}:${input.trialIndex}`,
    level: input.level,
    targetId: input.targetId,
    family: input.family,
    trialIndex: input.trialIndex,
    runId,
    seed: input.scenario.seed,
    expectedOutcome: expectedOutcome(input.scenario),
    scenario: structuredClone(input.scenario),
    scenarioHash: prepared.provenance.scenarioHash,
    truthCommitment: prepared.metadata.truthCommitment,
    artifactHashes: structuredClone(prepared.metadata.artifactHashes),
  };
}

export function buildV4CampaignCommitments(input: {
  campaignId: string;
  catalog: BandCatalog;
  candidate: FrozenCandidateIdentity;
  thresholds?: DetectionThresholds;
  randomizedRunsPerTargetFamily?: number;
}): V4CampaignCommitment[] {
  const plan = detectorQualificationPlan(input.catalog);
  const randomizedRuns = input.randomizedRunsPerTargetFamily ?? RANDOMIZED_RUNS_PER_TARGET_FAMILY;
  if (!Number.isInteger(randomizedRuns) || randomizedRuns < 1 || randomizedRuns > 1_000) throw new Error("Randomized run count is outside the campaign bound");
  const runnerOptions: SyntheticQualificationRunnerOptions = {
    bandCatalog: input.catalog,
    thresholds: input.thresholds,
    softwareBuild: input.candidate,
  };
  const commitments: V4CampaignCommitment[] = [];
  for (const target of plan.targets) {
    for (const family of FAMILIES) {
      const scenario = deterministicScenario(input.catalog, target.id, family);
      commitments.push(prepareCommitment({
        order: commitments.length,
        campaignId: input.campaignId,
        level: "isolated-deterministic",
        targetId: target.id,
        family,
        trialIndex: 0,
        scenario,
        runnerOptions,
      }));
    }
  }
  for (const target of plan.targets) {
    for (const family of FAMILIES) {
      for (let trialIndex = 0; trialIndex < randomizedRuns; trialIndex += 1) {
        const scenario = createRandomizedSyntheticScenario({ catalog: input.catalog, targetId: target.id, family, trialIndex });
        commitments.push(prepareCommitment({
          order: commitments.length,
          campaignId: input.campaignId,
          level: "isolated-randomized",
          targetId: target.id,
          family,
          trialIndex,
          scenario,
          runnerOptions,
        }));
      }
    }
  }
  if (commitments.length > MAX_CASES) throw new Error("V4 campaign exceeds its case-count bound");
  return commitments;
}

function jsonLineBuffer(values: unknown[]): Buffer {
  return Buffer.from(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

function canonicalBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExclusive(filePath: string, contents: Buffer | string): Promise<void> {
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
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Reads release.json and independently proves it matches the current source/package tree. */
export async function readFrozenCandidateIdentity(repositoryPath: string): Promise<FrozenCandidateIdentity> {
  const repositoryRoot = await realpath(path.resolve(repositoryPath));
  const metadata = exactCandidate(JSON.parse(await readFile(path.join(repositoryRoot, "dist", "release.json"), "utf8")));
  const [sourceDigest, packageDigest, dependencyLockDigest] = await Promise.all([
    digestReleaseFiles(repositoryRoot, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(repositoryRoot, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(repositoryRoot, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  if (metadata.sourceDigest !== sourceDigest || metadata.packageDigest !== packageDigest || metadata.dependencyLockDigest !== dependencyLockDigest) {
    throw new Error("dist/release.json does not match the current source/package/dependency-lock identity; rebuild before V4");
  }
  return metadata;
}

function exactCandidate(value: unknown): FrozenCandidateIdentity {
  const candidate = value as Partial<FrozenCandidateIdentity>;
  if (candidate?.schemaVersion !== 1 || candidate.product !== "rf-monitor") throw new Error("Frozen candidate identity is invalid");
  for (const field of ["sourceDigest", "packageDigest", "dependencyLockDigest"] as const) {
    if (!SHA256_PATTERN.test(String(candidate[field] ?? ""))) throw new Error(`Frozen candidate ${field} is invalid`);
  }
  if (typeof candidate.releaseVersion !== "string" || !candidate.releaseVersion || typeof candidate.buildId !== "string" || !candidate.buildId) {
    throw new Error("Frozen candidate version/build id is invalid");
  }
  return candidate as FrozenCandidateIdentity;
}

export async function snapshotProtectedTree(rootPath: string): Promise<ProtectedTreeSnapshot> {
  const root = path.resolve(rootPath);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", root, entries: 0, bytes: 0, sha256: sha256(`absent:${root}`) };
    }
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error("Protected field root must be a directory or absent");
  const files: Array<{ absolute: string; relative: string; size: number; mode: number }> = [];
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const details = await lstat(absolute);
      entries += 1;
      if (entries > MAX_PROTECTED_TREE_ENTRIES) {
        return { state: "bound-exceeded", root, entries, bytes, reason: `More than ${MAX_PROTECTED_TREE_ENTRIES} entries` };
      }
      if (details.isDirectory()) pending.push(absolute);
      else if (details.isFile()) {
        bytes += details.size;
        if (bytes > MAX_PROTECTED_TREE_BYTES) {
          return { state: "bound-exceeded", root, entries, bytes, reason: `More than ${MAX_PROTECTED_TREE_BYTES} bytes` };
        }
        files.push({ absolute, relative, size: details.size, mode: details.mode });
      } else {
        files.push({ absolute: "", relative: `${relative}:non-regular`, size: details.size, mode: details.mode });
      }
    }
  }
  const digest = createHash("sha256");
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    digest.update(`${file.relative}\0${file.size}\0${file.mode}\0`);
    if (file.absolute) {
      for await (const chunk of createReadStream(file.absolute)) digest.update(chunk as Buffer);
    }
    digest.update("\0");
  }
  return { state: "verified", root, entries, bytes, sha256: digest.digest("hex") };
}

function sameTree(left: ProtectedTreeSnapshot, right: ProtectedTreeSnapshot): boolean {
  return left.state !== "bound-exceeded"
    && left.state === right.state
    && left.root === right.root
    && left.entries === right.entries
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

function sameCandidate(left: FrozenCandidateIdentity, right: FrozenCandidateIdentity): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function validateCommitments(commitments: V4CampaignCommitment[]): void {
  if (!commitments.length || commitments.length > MAX_CASES) throw new Error("V4 commitments count is invalid");
  const ids = new Set<string>();
  for (const [index, commitment] of commitments.entries()) {
    if (commitment.schemaVersion !== 1 || commitment.order !== index || ids.has(commitment.caseId)) throw new Error(`V4 commitment ${index} is invalid or duplicated`);
    ids.add(commitment.caseId);
    if (!SHA256_PATTERN.test(commitment.scenarioHash) || !SHA256_PATTERN.test(commitment.truthCommitment)) throw new Error(`V4 commitment ${index} has invalid hashes`);
    if (sha256Canonical(commitment.scenario) !== commitment.scenarioHash) throw new Error(`V4 commitment ${index} scenario hash mismatch`);
    if (sha256Canonical({ runId: commitment.runId, scenarioHash: commitment.scenarioHash, artifactHashes: commitment.artifactHashes }) !== commitment.truthCommitment) {
      throw new Error(`V4 commitment ${index} truth commitment mismatch`);
    }
    if (commitment.scenario.seed !== commitment.seed || commitment.scenario.targets[0]?.id !== commitment.targetId || commitment.scenario.events[0]?.kind !== commitment.family) {
      throw new Error(`V4 commitment ${index} scenario identity mismatch`);
    }
  }
}

function validateCommitmentCoverage(manifest: V4CampaignManifest, commitments: V4CampaignCommitment[]): void {
  if (manifest.counts.targets !== manifest.frozen.targetIds.length || manifest.counts.families !== manifest.frozen.families.length
      || sha256Canonical(manifest.frozen.families) !== sha256Canonical(FAMILIES)
      || new Set(manifest.frozen.targetIds).size !== manifest.frozen.targetIds.length
      || new Set(manifest.frozen.families).size !== manifest.frozen.families.length) {
    throw new Error("V4 manifest target/family coverage is invalid");
  }
  const deterministicExpected = manifest.counts.targets * manifest.counts.families;
  const randomizedExpected = deterministicExpected * manifest.protocol.randomizedRunsPerTargetFamily;
  if (manifest.counts.deterministic !== deterministicExpected || manifest.counts.randomized !== randomizedExpected
      || manifest.counts.total !== deterministicExpected + randomizedExpected || commitments.length !== manifest.counts.total
      || manifest.commitments.lines !== commitments.length) {
    throw new Error("V4 manifest case counts are inconsistent");
  }
  for (const targetId of manifest.frozen.targetIds) {
    for (const family of manifest.frozen.families) {
      const deterministic = commitments.filter((entry) => entry.level === "isolated-deterministic" && entry.targetId === targetId && entry.family === family);
      const randomized = commitments.filter((entry) => entry.level === "isolated-randomized" && entry.targetId === targetId && entry.family === family)
        .sort((left, right) => left.trialIndex - right.trialIndex);
      if (deterministic.length !== 1 || deterministic[0].trialIndex !== 0 || randomized.length !== manifest.protocol.randomizedRunsPerTargetFamily
          || randomized.some((entry, index) => entry.trialIndex !== index)) {
        throw new Error(`V4 commitment coverage is incomplete for ${targetId}/${family}`);
      }
    }
  }
}

function createManifest(input: {
  options: V4CampaignExecutionOptions;
  commitments: V4CampaignCommitment[];
  commitmentsBuffer: Buffer;
  isolationBefore: ProtectedTreeSnapshot;
  randomizedRuns: number;
  createdAt: string;
  chunkCases: number;
}): V4CampaignManifest {
  const plan = detectorQualificationPlan(input.options.catalog);
  const deterministic = input.commitments.filter((entry) => entry.level === "isolated-deterministic").length;
  const randomized = input.commitments.length - deterministic;
  return {
    schemaVersion: V4_DETECTOR_CAMPAIGN_SCHEMA_VERSION,
    recordType: "rf-monitor-v4-detector-campaign",
    campaignVersion: V4_DETECTOR_CAMPAIGN_VERSION,
    campaignId: safeCampaignId(input.options.campaignId),
    createdAt: input.createdAt,
    scope: "conditional-detector-statistical-sub-gate",
    overallV4Eligible: false,
    release: exactCandidate(input.options.candidate),
    runtime: { executable: process.execPath, version: process.version },
    frozen: {
      planVersion: plan.version,
      planHash: sha256Canonical(plan),
      catalogVersion: input.options.catalog.catalogVersion,
      catalogHash: sha256Canonical(input.options.catalog),
      targetIds: plan.targets.map((target) => target.id),
      families: [...FAMILIES],
      detectorRuleSetId: (input.options.thresholds ?? DEFAULT_THRESHOLDS).ruleSetId,
      detectorRuleHash: detectionRuleFingerprint(input.options.thresholds ?? DEFAULT_THRESHOLDS),
    },
    protocol: {
      deterministicRunsPerTargetFamily: 1,
      randomizedRunsPerTargetFamily: input.randomizedRuns,
      confidence: CONFIDENCE,
      requiredLowerLimit: REQUIRED_LOWER_LIMIT,
      scoringUnit: "independent-run",
      executionPath: "generated FFT -> visit median -> DetectionEngine -> isolated scorer",
    },
    counts: { targets: plan.targets.length, families: FAMILIES.length, deterministic, randomized, total: input.commitments.length },
    commitments: {
      file: "commitments.jsonl",
      lines: input.commitments.length,
      bytes: input.commitmentsBuffer.byteLength,
      sha256: sha256(input.commitmentsBuffer),
      writtenBeforeDetectorExecution: true,
    },
    isolationBefore: input.isolationBefore,
    bounds: {
      maximumCases: MAX_CASES,
      resultChunkCases: input.chunkCases,
      maximumCommitmentsBytes: MAX_COMMITMENTS_BYTES,
      maximumChunkBytes: MAX_CHUNK_BYTES,
      maximumProtectedTreeEntries: MAX_PROTECTED_TREE_ENTRIES,
      maximumProtectedTreeBytes: MAX_PROTECTED_TREE_BYTES,
    },
    blockersOutsideThisSubGate: [
      "Packaged scheduler traversal not run",
      "Recovery and evidence lifecycle traversal not run",
      "Server-authoritative operator state and main UI traversal not run",
      "Held-out replay V5 not run",
      "Installed RF-chain V6 not run",
    ],
  };
}

function runRecord(commitment: V4CampaignCommitment, report: SyntheticQualificationReport): V4CampaignRunRecord {
  const event = report.score.eventScores[0];
  if (!event || event.targetId !== commitment.targetId || event.kind !== commitment.family) throw new Error(`Run ${commitment.caseId} returned the wrong scored event`);
  const overloadSeparated = commitment.family === "overload"
    ? report.observed.receiverOverload && !report.observed.rfAnomalyAlert && report.observed.alertKinds.every((kind) => kind === "overload")
    : !report.observed.receiverOverload;
  return {
    schemaVersion: 1,
    order: commitment.order,
    caseId: commitment.caseId,
    level: commitment.level,
    targetId: commitment.targetId,
    family: commitment.family,
    trialIndex: commitment.trialIndex,
    seed: commitment.seed,
    scenarioHash: commitment.scenarioHash,
    truthCommitment: commitment.truthCommitment,
    truthVerified: report.truth.verified && report.truth.commitment === commitment.truthCommitment,
    expectedOutcome: commitment.expectedOutcome,
    observedOutcome: report.observed.outcome,
    alertKinds: [...report.observed.alertKinds],
    verdict: event.verdict,
    detected: event.verdict === "detected",
    missed: event.verdict === "missed",
    correctNonDetection: event.verdict === "correct-non-detection",
    unknownObserved: event.verdict === "unknown-observed",
    unexpectedAlerts: report.score.unexpectedAlerts,
    falseAlertDurationMs: report.score.falseAlertDurationMs,
    ...(event.observedEventExposureMs === undefined ? {} : { observedEventExposureMs: event.observedEventExposureMs }),
    ...(event.wallClockLatencyMs === undefined ? {} : { wallClockLatencyMs: event.wallClockLatencyMs }),
    ...(event.observedExposureToAlertMs === undefined ? {} : { observedExposureToAlertMs: event.observedExposureToAlertMs }),
    ...(event.unobservedLatencyToAlertMs === undefined ? {} : { unobservedLatencyToAlertMs: event.unobservedLatencyToAlertMs }),
    overloadSeparated,
    dataDomain: "test",
    fieldWrites: 0,
    scorePassed: report.passed && overloadSeparated,
    reportHash: sha256Canonical(report),
  };
}

function validateRunRecord(record: V4CampaignRunRecord, commitment: V4CampaignCommitment): void {
  if (record.schemaVersion !== 1 || record.order !== commitment.order || record.caseId !== commitment.caseId
      || record.truthCommitment !== commitment.truthCommitment || record.scenarioHash !== commitment.scenarioHash
      || record.targetId !== commitment.targetId || record.family !== commitment.family || record.seed !== commitment.seed
      || record.level !== commitment.level || record.trialIndex !== commitment.trialIndex || record.expectedOutcome !== commitment.expectedOutcome
      || record.dataDomain !== "test" || record.fieldWrites !== 0 || !SHA256_PATTERN.test(record.reportHash)) {
    throw new Error(`V4 result ${record.caseId} does not match its pre-run commitment`);
  }
}

function latencySummary(values: Array<number | undefined>): V4LatencySummary {
  const ordered = values.filter((value): value is number => Number.isFinite(value) && Number(value) >= 0).sort((left, right) => left - right);
  if (!ordered.length) return { samples: 0 };
  const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
  return { samples: ordered.length, minimumMs: ordered[0], p50Ms: percentile(0.5), p95Ms: percentile(0.95), maximumMs: ordered.at(-1) };
}

function recordSuccess(record: V4CampaignRunRecord): boolean {
  if (!record.scorePassed || !record.truthVerified || !record.overloadSeparated || record.unexpectedAlerts !== 0) return false;
  if (ALERT_FAMILIES.has(record.family)) return record.detected;
  if (NEGATIVE_CONTROL_FAMILIES.has(record.family)) return record.correctNonDetection;
  return record.unknownObserved;
}

function aggregateOutcomes(manifest: V4CampaignManifest, records: V4CampaignRunRecord[]): V4TargetFamilyResult[] {
  const groups = new Map<string, V4CampaignRunRecord[]>();
  for (const record of records) {
    const key = `${record.targetId}\0${record.family}`;
    const entries = groups.get(key) ?? [];
    entries.push(record);
    groups.set(key, entries);
  }
  return [...groups.values()].map((entries) => {
    const first = entries[0];
    const deterministic = entries.filter((entry) => entry.level === "isolated-deterministic");
    const randomized = entries.filter((entry) => entry.level === "isolated-randomized");
    const successes = randomized.filter(recordSuccess).length;
    const criterion = ALERT_FAMILIES.has(first.family)
      ? "detection" as const
      : NEGATIVE_CONTROL_FAMILIES.has(first.family)
        ? "alert-free" as const
        : "unknown-observed" as const;
    const interval = criterion === "unknown-observed" || !randomized.length
      ? null
      : binomialWilsonOneSidedInterval(successes, randomized.length, CONFIDENCE);
    const statisticalPassed = randomized.length >= RANDOMIZED_RUNS_PER_TARGET_FAMILY
      && successes === randomized.length
      && (criterion === "unknown-observed" || Number(interval?.lower ?? 0) >= REQUIRED_LOWER_LIMIT);
    return {
      targetId: first.targetId,
      family: first.family,
      expectedOutcome: first.expectedOutcome,
      deterministic: {
        runs: deterministic.length,
        passed: deterministic.filter(recordSuccess).length,
        failed: deterministic.filter((entry) => !recordSuccess(entry)).length,
      },
      randomized: {
        runs: randomized.length,
        successes,
        failures: randomized.length - successes,
        interval,
        criterion,
        passed: statisticalPassed,
      },
      detections: entries.filter((entry) => entry.detected).length,
      misses: entries.filter((entry) => entry.missed).length,
      falseAlerts: entries.reduce((sum, entry) => sum + entry.unexpectedAlerts, 0),
      falseAlertDurationMs: entries.reduce((sum, entry) => sum + entry.falseAlertDurationMs, 0),
      latency: {
        wallClockMs: latencySummary(entries.map((entry) => entry.wallClockLatencyMs)),
        observedExposureMs: latencySummary(entries.map((entry) => entry.observedExposureToAlertMs)),
        unobservedMs: latencySummary(entries.map((entry) => entry.unobservedLatencyToAlertMs)),
      },
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId) || left.family.localeCompare(right.family));
}

function parseJsonLines<T>(buffer: Buffer, label: string, maximumBytes: number): T[] {
  if (buffer.byteLength <= 0 || buffer.byteLength > maximumBytes) throw new Error(`${label} exceeds its byte bound`);
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n")) throw new Error(`${label} is not newline-terminated`);
  return text.trimEnd().split("\n").map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid`, { cause: error });
    }
  });
}

async function readChunks(resultsPath: string, commitments: V4CampaignCommitment[]): Promise<{ records: V4CampaignRunRecord[]; nextChunkIndex: number }> {
  const names = (await readdir(resultsPath)).filter((name) => /^chunk-\d{6}\.json$/.test(name)).sort();
  const records: V4CampaignRunRecord[] = [];
  for (const [expectedChunkIndex, name] of names.entries()) {
    if (name !== `chunk-${String(expectedChunkIndex).padStart(6, "0")}.json`) throw new Error("V4 result chunks are not contiguous");
    const buffer = await readFile(path.join(resultsPath, name));
    if (buffer.byteLength <= 0 || buffer.byteLength > MAX_CHUNK_BYTES) throw new Error(`V4 result chunk ${name} exceeds its byte bound`);
    const chunk = JSON.parse(buffer.toString("utf8")) as V4ResultChunk;
    if (chunk.schemaVersion !== 1 || chunk.chunkIndex !== expectedChunkIndex || chunk.recordCount !== chunk.records?.length
        || chunk.firstOrder !== records.length || chunk.lastOrder !== records.length + chunk.recordCount - 1
        || chunk.recordsHash !== sha256Canonical(chunk.records)) throw new Error(`V4 result chunk ${name} is invalid`);
    for (const record of chunk.records) {
      const commitment = commitments[records.length];
      if (!commitment) throw new Error("V4 results exceed commitments");
      validateRunRecord(record, commitment);
      records.push(record);
    }
  }
  return { records, nextChunkIndex: names.length };
}

async function writeChunk(resultsPath: string, chunkIndex: number, records: V4CampaignRunRecord[]): Promise<void> {
  if (!records.length) return;
  const chunk: V4ResultChunk = {
    schemaVersion: 1,
    chunkIndex,
    firstOrder: records[0].order,
    lastOrder: records.at(-1)!.order,
    recordCount: records.length,
    recordsHash: sha256Canonical(records),
    records,
  };
  const contents = canonicalBuffer(chunk);
  if (contents.byteLength > MAX_CHUNK_BYTES) throw new Error("V4 result chunk exceeds its byte bound");
  await writeExclusive(path.join(resultsPath, `chunk-${String(chunkIndex).padStart(6, "0")}.json`), contents);
  await syncDirectory(resultsPath);
}

async function finalizeBundle(input: {
  partialPath: string;
  finalPath: string;
  manifest: V4CampaignManifest;
  commitmentsBuffer: Buffer;
  records: V4CampaignRunRecord[];
  report: V4CampaignReport;
}): Promise<void> {
  const reportBuffer = canonicalBuffer(input.report);
  await writeExclusive(path.join(input.partialPath, "report.json"), reportBuffer);
  const relativeFiles = ["commitments.jsonl", "manifest.json", "report.json"];
  const resultNames = (await readdir(path.join(input.partialPath, "results"))).filter((name) => /^chunk-\d{6}\.json$/.test(name)).sort();
  relativeFiles.push(...resultNames.map((name) => `results/${name}`));
  const sums: string[] = [];
  for (const relative of relativeFiles.sort()) {
    const contents = await readFile(path.join(input.partialPath, ...relative.split("/")));
    sums.push(`${sha256(contents)}  ${relative}`);
    await chmod(path.join(input.partialPath, ...relative.split("/")), 0o440);
  }
  await writeExclusive(path.join(input.partialPath, "SHA256SUMS"), `${sums.join("\n")}\n`);
  await chmod(path.join(input.partialPath, "SHA256SUMS"), 0o440);
  await chmod(path.join(input.partialPath, "results"), 0o550);
  await syncDirectory(input.partialPath);
  await chmod(input.partialPath, 0o550);
  await rename(input.partialPath, input.finalPath);
  await syncDirectory(path.dirname(input.finalPath));
}

export async function executeV4DetectorCampaign(options: V4CampaignExecutionOptions): Promise<V4CampaignExecutionResult> {
  const repositoryRoot = await realpath(path.resolve(options.repositoryRoot));
  const campaignId = safeCampaignId(options.campaignId);
  const outputRoot = path.resolve(options.outputRoot);
  if (outputRoot === path.parse(outputRoot).root || outputRoot === repositoryRoot) throw new Error("V4 output root is too broad");
  const finalPath = path.join(outputRoot, campaignId);
  const partialPath = path.join(outputRoot, `.partial-${campaignId}`);
  try {
    await verifyV4CampaignBundle(finalPath);
    const existing = JSON.parse(await readFile(path.join(finalPath, "report.json"), "utf8")) as V4CampaignReport;
    return { state: "complete", bundlePath: finalPath, completedCases: existing.executedCases, totalCases: existing.executedCases, report: existing };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const chunkCases = options.chunkCases ?? DEFAULT_CHUNK_CASES;
  if (!Number.isInteger(chunkCases) || chunkCases < 1 || chunkCases > 500) throw new Error("V4 result chunk size is invalid");
  const randomizedRuns = options.randomizedRunsPerTargetFamily ?? RANDOMIZED_RUNS_PER_TARGET_FAMILY;
  if (randomizedRuns >= RANDOMIZED_RUNS_PER_TARGET_FAMILY && process.execPath !== "/usr/bin/node") {
    throw new Error(`V4 qualification must run with /usr/bin/node; current executable is ${process.execPath}`);
  }
  const currentCandidate = exactCandidate(await options.readCandidate());
  if (!sameCandidate(options.candidate, currentCandidate)) throw new Error("Current source/package identity differs from the frozen V4 candidate");
  await mkdir(outputRoot, { recursive: true });

  let manifest: V4CampaignManifest;
  let commitments: V4CampaignCommitment[];
  let commitmentsBuffer: Buffer;
  try {
    manifest = JSON.parse(await readFile(path.join(partialPath, "manifest.json"), "utf8")) as V4CampaignManifest;
    commitmentsBuffer = await readFile(path.join(partialPath, "commitments.jsonl"));
    commitments = parseJsonLines<V4CampaignCommitment>(commitmentsBuffer, "V4 commitments", MAX_COMMITMENTS_BYTES);
    validateCommitments(commitments);
    validateCommitmentCoverage(manifest, commitments);
    if (manifest.schemaVersion !== 1 || manifest.campaignId !== campaignId || manifest.commitments.sha256 !== sha256(commitmentsBuffer)
        || manifest.commitments.lines !== commitments.length || manifest.release.sourceDigest !== options.candidate.sourceDigest
        || manifest.release.packageDigest !== options.candidate.packageDigest || manifest.frozen.catalogHash !== sha256Canonical(options.catalog)
        || manifest.frozen.detectorRuleHash !== detectionRuleFingerprint(options.thresholds ?? DEFAULT_THRESHOLDS)) {
      throw new Error("Existing V4 partial campaign does not match the frozen candidate/configuration");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const isolationBefore = await snapshotProtectedTree(options.protectedFieldRoot);
    commitments = buildV4CampaignCommitments({
      campaignId,
      catalog: options.catalog,
      candidate: options.candidate,
      thresholds: options.thresholds,
      randomizedRunsPerTargetFamily: randomizedRuns,
    });
    validateCommitments(commitments);
    commitmentsBuffer = jsonLineBuffer(commitments);
    if (commitmentsBuffer.byteLength > MAX_COMMITMENTS_BYTES) throw new Error("V4 commitments exceed their byte bound");
    manifest = createManifest({
      options,
      commitments,
      commitmentsBuffer,
      isolationBefore,
      randomizedRuns,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      chunkCases,
    });
    validateCommitmentCoverage(manifest, commitments);
    await mkdir(path.join(partialPath, "results"), { recursive: true, mode: 0o750 });
    // Both files are durable before the first detector execution. The manifest
    // binds the exact commitments-file hash and candidate identity.
    await writeExclusive(path.join(partialPath, "commitments.jsonl"), commitmentsBuffer);
    await writeExclusive(path.join(partialPath, "manifest.json"), canonicalBuffer(manifest));
    await syncDirectory(partialPath);
  }

  const resultsPath = path.join(partialPath, "results");
  const loaded = await readChunks(resultsPath, commitments);
  const records = loaded.records;
  let chunkIndex = loaded.nextChunkIndex;
  const maximumNew = options.maxNewCases ?? Number.POSITIVE_INFINITY;
  if (!(maximumNew === Number.POSITIVE_INFINITY || (Number.isInteger(maximumNew) && maximumNew >= 0))) throw new Error("maxNewCases is invalid");
  let executedNow = 0;
  while (records.length < commitments.length && executedNow < maximumNew) {
    const chunk: V4CampaignRunRecord[] = [];
    const allowed = Math.min(chunkCases, commitments.length - records.length, maximumNew - executedNow);
    for (let index = 0; index < allowed; index += 1) {
      const commitment = commitments[records.length + chunk.length];
      const report = runSyntheticQualificationDefinition(commitment.scenario, "blinded", {
        bandCatalog: options.catalog,
        thresholds: options.thresholds,
        softwareBuild: options.candidate,
        runId: commitment.runId,
        expectedTruthCommitment: commitment.truthCommitment,
        qualificationLevel: commitment.level,
      });
      const record = runRecord(commitment, report);
      validateRunRecord(record, commitment);
      chunk.push(record);
    }
    await writeChunk(resultsPath, chunkIndex, chunk);
    records.push(...chunk);
    executedNow += chunk.length;
    chunkIndex += 1;
    options.onProgress?.(records.length, commitments.length);
  }
  if (records.length < commitments.length) {
    return { state: "paused", bundlePath: partialPath, completedCases: records.length, totalCases: commitments.length };
  }

  const isolationAfter = await snapshotProtectedTree(options.protectedFieldRoot);
  const candidateAfter = exactCandidate(await options.readCandidate());
  const outcomes = aggregateOutcomes(manifest, records);
  const deterministicPassed = outcomes.length === manifest.counts.targets * manifest.counts.families
    && outcomes.every((outcome) => outcome.deterministic.runs === 1 && outcome.deterministic.passed === 1);
  const randomizedPassed = outcomes.length === manifest.counts.targets * manifest.counts.families
    && outcomes.every((outcome) => outcome.randomized.passed);
  const isolationPassed = sameTree(manifest.isolationBefore, isolationAfter) && records.every((record) => record.dataDomain === "test" && record.fieldWrites === 0);
  const candidateStayedFrozen = sameCandidate(manifest.release, candidateAfter);
  const subGatePassed = deterministicPassed && randomizedPassed && isolationPassed && candidateStayedFrozen
    && records.every((record) => record.truthVerified && record.overloadSeparated);
  const report: V4CampaignReport = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-detector-campaign-result",
    campaignId,
    completedAt: (options.now ?? (() => new Date()))().toISOString(),
    manifestHash: sha256(await readFile(path.join(partialPath, "manifest.json"))),
    commitmentsHash: sha256(commitmentsBuffer),
    executedCases: records.length,
    truthCommitmentsVerified: records.filter((record) => record.truthVerified).length,
    outcomes,
    totals: {
      detections: records.filter((record) => record.detected).length,
      misses: records.filter((record) => record.missed).length,
      falseAlerts: records.reduce((sum, record) => sum + record.unexpectedAlerts, 0),
      falseAlertDurationMs: records.reduce((sum, record) => sum + record.falseAlertDurationMs, 0),
      unknownExpected: records.filter((record) => record.expectedOutcome === "unknown").length,
      unknownObserved: records.filter((record) => record.unknownObserved).length,
    },
    isolation: {
      executionDomain: "test",
      fieldPersistenceDependency: "none",
      fieldWritesReported: 0,
      before: manifest.isolationBefore,
      after: isolationAfter,
      unchanged: isolationPassed,
    },
    candidate: {
      before: manifest.release,
      after: candidateAfter,
      unchanged: candidateStayedFrozen,
      runtimeExecutable: process.execPath,
      runtimeMatches: process.execPath === "/usr/bin/node",
    },
    result: {
      deterministicFixturesPassed: deterministicPassed,
      randomizedStatisticalCriteriaPassed: randomizedPassed,
      isolationPassed,
      candidateStayedFrozen,
      detectorStatisticalSubGate: subGatePassed && process.execPath === "/usr/bin/node" ? "passed" : "failed",
      overallV4: "not-passed",
      productionReady: false,
    },
    remainingV4Blockers: [...manifest.blockersOutsideThisSubGate],
    downstreamGates: { V5: "not-run", V6: "not-run" },
    limitations: [
      "This conditional result covers generated normalized FFT input, visit aggregation, DetectionEngine, and isolated scoring only.",
      "It does not exercise the packaged scheduler, recovery, evidence lifecycle, server operator state, or rendered main UI.",
      "Synthetic results do not qualify the RSPdx/RSPdx R2, SDRconnect, installed RF chain, antenna system, or site.",
      "RF-only normalized spectra cannot establish spoofing, navigation integrity, deliberate intent, dBm, or field strength.",
    ],
  };
  await finalizeBundle({ partialPath, finalPath, manifest, commitmentsBuffer, records, report });
  return { state: "complete", bundlePath: finalPath, completedCases: records.length, totalCases: commitments.length, report };
}

export async function verifyV4CampaignBundle(bundlePath: string): Promise<{ files: number; valid: true }> {
  const root = path.resolve(bundlePath);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) throw new Error("V4 bundle root is not a regular directory");
  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  for (const required of ["SHA256SUMS", "commitments.jsonl", "manifest.json", "report.json", "results"]) {
    if (!rootNames.has(required)) throw new Error(`V4 bundle is missing ${required}`);
  }
  if ([...rootNames].some((name) => !["SHA256SUMS", "commitments.jsonl", "manifest.json", "report.json", "results"].includes(name))) {
    throw new Error("V4 bundle contains an unexpected root entry");
  }
  for (const entry of rootEntries) {
    const details = await lstat(path.join(root, entry.name));
    if (details.isSymbolicLink()) throw new Error(`V4 bundle contains symlink ${entry.name}`);
    if (entry.name === "results" ? !details.isDirectory() : !details.isFile()) throw new Error(`V4 bundle entry ${entry.name} has the wrong type`);
  }
  const resultEntries = await readdir(path.join(root, "results"), { withFileTypes: true });
  for (const entry of resultEntries) {
    const details = await lstat(path.join(root, "results", entry.name));
    if (!/^chunk-\d{6}\.json$/.test(entry.name) || !details.isFile() || details.isSymbolicLink()) {
      throw new Error(`V4 bundle contains invalid result entry ${entry.name}`);
    }
  }
  const actualFiles = new Set([
    "commitments.jsonl",
    "manifest.json",
    "report.json",
    ...resultEntries.map((entry) => `results/${entry.name}`),
  ]);
  const sumsBuffer = await readFile(path.join(root, "SHA256SUMS"));
  if (!sumsBuffer.byteLength || sumsBuffer.byteLength > 1024 * 1024 || sumsBuffer.at(-1) !== 0x0a) throw new Error("V4 SHA256SUMS is invalid or not newline-terminated");
  const lines = sumsBuffer.toString("utf8").trimEnd().split("\n");
  const listedFiles = new Set<string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    const relative = match?.[2] ?? "";
    const segments = relative.split("/");
    if (!match || path.isAbsolute(relative) || relative.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")
        || relative === "SHA256SUMS" || listedFiles.has(relative) || !actualFiles.has(relative)) {
      throw new Error("V4 SHA256SUMS entry is invalid, duplicated, reserved, or unexpected");
    }
    listedFiles.add(relative);
    const filePath = path.join(root, ...segments);
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`V4 committed path ${relative} is not a regular file`);
    const contents = await readFile(filePath);
    if (sha256(contents) !== match[1]) throw new Error(`V4 bundle hash mismatch for ${relative}`);
  }
  if (listedFiles.size !== actualFiles.size || [...actualFiles].some((relative) => !listedFiles.has(relative))) {
    throw new Error("V4 SHA256SUMS does not cover the exact committed file set");
  }

  const manifestBuffer = await readFile(path.join(root, "manifest.json"));
  const commitmentsBuffer = await readFile(path.join(root, "commitments.jsonl"));
  const reportBuffer = await readFile(path.join(root, "report.json"));
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as V4CampaignManifest;
  const report = JSON.parse(reportBuffer.toString("utf8")) as V4CampaignReport;
  const commitments = parseJsonLines<V4CampaignCommitment>(commitmentsBuffer, "V4 commitments", MAX_COMMITMENTS_BYTES);
  validateCommitments(commitments);
  if (manifest.schemaVersion !== 1 || manifest.recordType !== "rf-monitor-v4-detector-campaign"
      || manifest.campaignVersion !== V4_DETECTOR_CAMPAIGN_VERSION || manifest.scope !== "conditional-detector-statistical-sub-gate"
      || manifest.overallV4Eligible !== false || manifest.commitments.file !== "commitments.jsonl"
      || manifest.commitments.bytes !== commitmentsBuffer.byteLength || manifest.commitments.sha256 !== sha256(commitmentsBuffer)
      || manifest.commitments.writtenBeforeDetectorExecution !== true || manifest.protocol.deterministicRunsPerTargetFamily !== 1
      || manifest.protocol.confidence !== CONFIDENCE || manifest.protocol.requiredLowerLimit !== REQUIRED_LOWER_LIMIT
      || manifest.protocol.scoringUnit !== "independent-run" || manifest.frozen.planVersion !== DETECTOR_QUALIFICATION_PLAN_VERSION) {
    throw new Error("V4 manifest semantics are invalid");
  }
  exactCandidate(manifest.release);
  validateCommitmentCoverage(manifest, commitments);
  const loaded = await readChunks(path.join(root, "results"), commitments);
  if (loaded.records.length !== commitments.length || loaded.nextChunkIndex !== resultEntries.length) {
    throw new Error("V4 result chunks are partial or do not cover every commitment");
  }
  const records = loaded.records;
  const outcomes = aggregateOutcomes(manifest, records);
  const deterministicPassed = outcomes.length === manifest.counts.targets * manifest.counts.families
    && outcomes.every((outcome) => outcome.deterministic.runs === 1 && outcome.deterministic.passed === 1);
  const randomizedPassed = outcomes.length === manifest.counts.targets * manifest.counts.families
    && outcomes.every((outcome) => outcome.randomized.passed);
  const isolationPassed = sameTree(manifest.isolationBefore, report.isolation.after)
    && records.every((record) => record.dataDomain === "test" && record.fieldWrites === 0);
  const candidateStayedFrozen = sameCandidate(manifest.release, exactCandidate(report.candidate?.after));
  const runtimeMatches = manifest.runtime.executable === "/usr/bin/node"
    && report.candidate?.runtimeExecutable === manifest.runtime.executable
    && report.candidate?.runtimeMatches === true;
  const subGatePassed = deterministicPassed && randomizedPassed && isolationPassed && candidateStayedFrozen && runtimeMatches
    && records.every((record) => record.truthVerified && record.overloadSeparated);
  const expectedTotals = {
    detections: records.filter((record) => record.detected).length,
    misses: records.filter((record) => record.missed).length,
    falseAlerts: records.reduce((sum, record) => sum + record.unexpectedAlerts, 0),
    falseAlertDurationMs: records.reduce((sum, record) => sum + record.falseAlertDurationMs, 0),
    unknownExpected: records.filter((record) => record.expectedOutcome === "unknown").length,
    unknownObserved: records.filter((record) => record.unknownObserved).length,
  };
  if (report.schemaVersion !== 1 || report.recordType !== "rf-monitor-v4-detector-campaign-result" || report.campaignId !== manifest.campaignId
      || !Number.isFinite(Date.parse(report.completedAt)) || report.manifestHash !== sha256(manifestBuffer)
      || report.commitmentsHash !== sha256(commitmentsBuffer) || report.executedCases !== commitments.length
      || report.truthCommitmentsVerified !== records.filter((record) => record.truthVerified).length
      || sha256Canonical(report.outcomes) !== sha256Canonical(outcomes) || sha256Canonical(report.totals) !== sha256Canonical(expectedTotals)
      || report.isolation.executionDomain !== "test" || report.isolation.fieldPersistenceDependency !== "none"
      || report.isolation.fieldWritesReported !== 0 || report.isolation.unchanged !== isolationPassed
      || !sameCandidate(report.candidate.before, manifest.release) || report.candidate.unchanged !== candidateStayedFrozen
      || report.result.deterministicFixturesPassed !== deterministicPassed
      || report.result.randomizedStatisticalCriteriaPassed !== randomizedPassed || report.result.isolationPassed !== isolationPassed
      || report.result.candidateStayedFrozen !== candidateStayedFrozen
      || report.result.detectorStatisticalSubGate !== (subGatePassed ? "passed" : "failed")
      || report.result.overallV4 !== "not-passed" || report.result.productionReady !== false
      || report.downstreamGates.V5 !== "not-run" || report.downstreamGates.V6 !== "not-run"
      || sha256Canonical(report.remainingV4Blockers) !== sha256Canonical(manifest.blockersOutsideThisSubGate)
      || !Array.isArray(report.limitations) || report.limitations.length < 3) {
    throw new Error("V4 report semantics or derived results are invalid");
  }
  return { files: lines.length, valid: true };
}
