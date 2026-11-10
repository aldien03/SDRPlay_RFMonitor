import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import operationalJson from "../config/operational.example.json";
import { detectorQualificationPlan } from "../src/shared/detectorQualification";
import { validateOperationalSettings } from "../src/shared/settings";
import type { OperationalSettings } from "../src/shared/types";
import { operationalConfigurationHash } from "../src/server/config";
import {
  createV6FinalWitnessStatement,
  createV6ProtocolWitnessStatement,
  createV5IndependentVerificationStatement,
  runV6ConductedQualification,
  scoreV6MeasurementCase,
  sha256CanonicalV6,
  V6_CASE_KINDS,
  V6_CONDUCTED_FRAMEWORK_VERSION,
  V6_INDEPENDENT_RUNS_PER_TARGET_CASE,
  V6_PREREQUISITE_GATES,
  V6_PREREQUISITE_SOURCE_ROLES,
  v6BaselineSetFingerprint,
  v6CaseResultFingerprint,
  v6InstalledChainFingerprint,
  v6PrerequisiteSourceSetFingerprint,
  v6WitnessKeyFingerprint,
  v6WitnessMessage,
  v5IndependentVerifierMessage,
  verifyV6ConductedBundle,
  writeV6ConductedBundle,
  type V6AcquisitionDescriptor,
  type V6ApprovedBinding,
  type V6CandidateContext,
  type V6CampaignFileEntry,
  type V6CampaignManifest,
  type V6ConductedProtocol,
  type V6DeclaredResult,
  type V6MatrixCase,
  type V6PrerequisiteSourceReference,
  type V6PrerequisiteWrapper,
  type V6RawMeasurementTable,
  type V6WitnessContext,
} from "../src/server/conductedRfQualification";
import type { FrozenCandidateIdentity } from "../src/server/syntheticQualificationCampaign";
import { TEST_CATALOG } from "./catalogFixture";

const RELEASE: FrozenCandidateIdentity = {
  schemaVersion: 1,
  product: "rf-monitor",
  releaseVersion: "1.0.0-v6-fixture",
  buildId: "1.0.0+v6frameworkfixture",
  sourceDigest: "1".repeat(64),
  packageDigest: "2".repeat(64),
  dependencyLockDigest: "3".repeat(64),
};

const KEYS = generateKeyPairSync("ed25519");
const PUBLIC_KEY = KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_SHA256 = v6WitnessKeyFingerprint(PUBLIC_KEY);
const WITNESS: V6WitnessContext = { publicKeyPem: PUBLIC_KEY, expectedKeySha256: KEY_SHA256 };
const V5_VERIFIER_KEYS = generateKeyPairSync("ed25519");
const V5_VERIFIER_PUBLIC_KEY = V5_VERIFIER_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const V5_VERIFIER_KEY_SHA256 = v6WitnessKeyFingerprint(V5_VERIFIER_PUBLIC_KEY);
const operational = validateOperationalSettings(operationalJson as unknown as OperationalSettings, TEST_CATALOG);
const CANDIDATE: V6CandidateContext = {
  release: RELEASE,
  catalog: TEST_CATALOG,
  configurationSha256: operationalConfigurationHash(operational, TEST_CATALOG.catalogVersion),
  catalogSha256: sha256CanonicalV6(TEST_CATALOG),
};
const PLAN_TARGETS = detectorQualificationPlan(TEST_CATALOG).targets;
const TIMES = {
  prerequisite: "2026-01-01T00:00:00.000Z",
  approved: "2026-01-02T00:00:00.000Z",
  protocol: "2026-01-03T00:00:00.000Z",
  protocolSigned: "2026-01-03T01:00:00.000Z",
  firstExposure: "2026-01-04T00:00:00.000Z",
  completed: "2026-01-05T00:00:00.000Z",
  finalSigned: "2026-01-05T01:00:00.000Z",
} as const;

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(name: string): string {
  return hash(`test-only-${name}`);
}

function createBinding(): V6ApprovedBinding {
  const targets = PLAN_TARGETS.map((target) => ({
    targetId: target.id,
    centerHz: target.centerHz,
    captureSpanHz: target.captureSpanHz,
    analysisSpanHz: target.analysisSpanHz,
    analysisMaskSha256: hash(`mask:${target.id}`),
    baselineId: `protected-${target.id}`,
    baselineDescriptorSha256: hash(`baseline-descriptor:${target.id}`),
    baselineFingerprintSha256: hash(`baseline-fingerprint:${target.id}`),
  }));
  const binding: V6ApprovedBinding = {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-approved-binding",
    approvedAt: TIMES.approved,
    release: RELEASE,
    configuration: {
      configurationSha256: CANDIDATE.configurationSha256,
      catalogVersion: TEST_CATALOG.catalogVersion,
      catalogSha256: CANDIDATE.catalogSha256,
    },
    site: { bindingSha256: identity("site") },
    receiver: { model: "RSPdx R2", serialSha256: identity("receiver-serial") },
    installedChain: {
      fingerprintSha256: "0".repeat(64),
      injectionReferencePlaneSha256: identity("reference-plane"),
      componentSha256: {
        antenna: identity("antenna"),
        cable: identity("cable"),
        filter: identity("filter"),
        lna: identity("lna"),
        attenuator: identity("attenuator"),
        surgeProtection: null,
      },
    },
    rf: {
      sdrconnectVersion: "1.2.3-v6-fixture",
      fixedGainProfileSha256: identity("fixed-gain"),
      sampleRateHz: 10_000_000,
      inputBinCount: 16,
      analysisStartBin: 2,
      analysisEndBin: 14,
      spectrumReference: 0,
      spectrumBase: 0,
      normalizedEncoding: "uint8-display-values",
      iq: false,
    },
    targets,
    baselineSetSha256: v6BaselineSetFingerprint(targets),
  };
  binding.installedChain.fingerprintSha256 = v6InstalledChainFingerprint(binding);
  return binding;
}

function expectedCase(target: V6ApprovedBinding["targets"][number], kind: typeof V6_CASE_KINDS[number], independentRun: number): V6MatrixCase {
  const caseId = `${target.targetId}-${kind}-${String(independentRun).padStart(2, "0")}`;
  const generatorFrequencyHz = kind === "sham" || kind === "target-range"
    ? null
    : kind === "guard-only"
      ? target.centerHz + target.analysisSpanHz / 2 + (target.captureSpanHz - target.analysisSpanHz) / 4
      : target.centerHz + independentRun * 100;
  const occupiedWidthHz = kind === "wideband"
    ? { minimum: 4_000_000, maximum: 6_000_000 }
    : kind === "cw"
      ? { minimum: 1_000, maximum: 20_000 }
      : kind === "multitone"
        ? { minimum: 20_000, maximum: 100_000 }
        : kind === "moving-narrowband"
          ? { minimum: 20_000, maximum: 200_000 }
          : null;
  return {
    caseId,
    targetId: target.targetId,
    kind,
    independentRun,
    acquisitionDescriptorPath: `acquisitions/${caseId}/acquisition.json`,
    rawTablePath: `acquisitions/${caseId}/raw-table.json`,
    evidencePath: `acquisitions/${caseId}/evidence.txt`,
    expected: {
      outcome: kind === "target-range" || kind === "frequency-accuracy" ? "metadata-match" : ["wideband", "cw", "multitone", "moving-narrowband"].includes(kind) ? "alert" : kind === "overload" ? "overload" : "no-alert",
      stimulusEnabled: kind !== "sham" && kind !== "target-range",
      generatorFrequencyHz,
      sourceLevelDbmAtGeneratorPort: generatorFrequencyHz === null ? null : { minimum: -100, maximum: -40 },
      occupiedWidthHz,
      maximumAbsoluteFrequencyErrorHz: kind === "frequency-accuracy" ? 1_000 : null,
    },
  };
}

function acquisitionFor(binding: V6ApprovedBinding, campaignId: string, entry: V6MatrixCase, index: number): V6AcquisitionDescriptor {
  const target = binding.targets.find((candidate) => candidate.targetId === entry.targetId)!;
  const firstExposureAt = new Date(Date.parse(TIMES.firstExposure) + index * 2_000).toISOString();
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-conducted-acquisition",
    campaignId,
    caseId: entry.caseId,
    acquisitionId: `acq-${entry.caseId}`,
    firstExposureAt,
    lastExposureAt: new Date(Date.parse(firstExposureAt) + 1_000).toISOString(),
    source: {
      receiverModel: binding.receiver.model,
      receiverSerialSha256: binding.receiver.serialSha256,
      installedChainFingerprintSha256: binding.installedChain.fingerprintSha256,
      sdrconnectVersion: binding.rf.sdrconnectVersion,
      fixedGainProfileSha256: binding.rf.fixedGainProfileSha256,
      sampleRateHz: 10_000_000,
      normalizedEncoding: "uint8-display-values",
      realReceiver: true,
      synthetic: false,
      simulation: false,
      replay: false,
      iq: false,
      dataDomain: "test",
      coupling: "conducted-shielded",
      radiated: false,
    },
    target: { ...target },
    fft: {
      path: `acquisitions/${entry.caseId}/fft.uint8`,
      rows: 3,
      inputBinCount: binding.rf.inputBinCount,
      bytes: 3 * binding.rf.inputBinCount,
    },
  };
}

function rawFor(binding: V6ApprovedBinding, campaignId: string, entry: V6MatrixCase): V6RawMeasurementTable {
  const target = binding.targets.find((candidate) => candidate.targetId === entry.targetId)!;
  const alertKinds: V6RawMeasurementTable["observation"]["alertKinds"] = entry.kind === "wideband"
    ? ["wideband-rise"]
    : ["cw", "multitone", "moving-narrowband"].includes(entry.kind)
      ? ["narrowband-spike"]
      : entry.kind === "overload"
        ? ["overload"]
        : [];
  const outcome = entry.expected.outcome;
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-raw-measurement",
    campaignId,
    caseId: entry.caseId,
    acquisitionId: `acq-${entry.caseId}`,
    targetId: entry.targetId,
    kind: entry.kind,
    dataDomain: "test",
    coupling: "conducted-shielded",
    radiated: false,
    iq: false,
    stimulus: {
      enabled: entry.expected.stimulusEnabled,
      generatorFrequencyHz: entry.expected.generatorFrequencyHz,
      sourceLevelDbmAtGeneratorPort: entry.expected.sourceLevelDbmAtGeneratorPort ? -70 : null,
      occupiedWidthHz: entry.expected.occupiedWidthHz ? (entry.expected.occupiedWidthHz.minimum + entry.expected.occupiedWidthHz.maximum) / 2 : null,
    },
    observation: {
      outcome,
      attributedTargetId: outcome === "no-alert" ? null : entry.targetId,
      confirmedCenterHz: target.centerHz,
      confirmedSampleRateHz: 10_000_000,
      captureStartHz: target.centerHz - target.captureSpanHz / 2,
      captureEndHz: target.centerHz + target.captureSpanHz / 2,
      analysisStartHz: target.centerHz - target.analysisSpanHz / 2,
      analysisEndHz: target.centerHz + target.analysisSpanHz / 2,
      observedPeakHz: entry.kind === "frequency-accuracy" ? entry.expected.generatorFrequencyHz! + 100 : null,
      alertKinds,
      overloadObserved: entry.kind === "overload",
      acceptedFrames: 3,
      invalidOrStaleFrames: 0,
    },
    uncertainty: { frequencyHz: 10, sourceLevelDb: 0.5 },
  };
}

interface FixtureDraft {
  binding: V6ApprovedBinding;
  protocol: V6ConductedProtocol;
  acquisitions: Map<string, V6AcquisitionDescriptor>;
  rawTables: Map<string, V6RawMeasurementTable>;
}

interface FixtureOptions {
  mutate?: (draft: FixtureDraft) => void;
  privateKey?: typeof KEYS.privateKey;
  forgedPassStubGate?: "V2";
  forgeV5VerifierSignature?: boolean;
}

async function writePayload(root: string, relative: string, bytes: string | Uint8Array): Promise<V6CampaignFileEntry> {
  const filePath = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  const value = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return { path: relative, bytes: value.byteLength, sha256: hash(value) };
}

async function makeReadOnly(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        await chmod(filePath, 0o550);
      } else await chmod(filePath, 0o440);
    }
  };
  await visit(root);
  await chmod(root, 0o550);
}

async function makeWritable(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    await chmod(directory, 0o750).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(filePath);
      else await chmod(filePath, 0o640).catch(() => undefined);
    }
  };
  await visit(root);
}

async function buildFixture(root: string, options: FixtureOptions = {}): Promise<{ root: string; binding: V6ApprovedBinding; bindingSha256: string; protocol: V6ConductedProtocol }> {
  await mkdir(root, { recursive: true });
  const binding = createBinding();
  const bindingSha256 = sha256CanonicalV6(binding);
  const campaignId = "v6-conducted-framework-fixture";
  const matrix = binding.targets.flatMap((target) => V6_CASE_KINDS.flatMap((kind) => Array.from({ length: V6_INDEPENDENT_RUNS_PER_TARGET_CASE }, (_, index) => expectedCase(target, kind, index + 1))));
  const protocol: V6ConductedProtocol = {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-conducted-protocol",
    frameworkVersion: V6_CONDUCTED_FRAMEWORK_VERSION,
    campaignId,
    committedAt: TIMES.protocol,
    approvedBindingSha256: bindingSha256,
    binding,
    identities: {
      implementerIdentitySha256: identity("implementer"),
      custodyIdentitySha256: identity("custody"),
      witnessIdentitySha256: identity("witness"),
    },
    v5ReplayVerification: {
      verifierIdentitySha256: identity("v5-independent-verifier"),
      verifierKeySha256: V5_VERIFIER_KEY_SHA256,
    },
    method: { dataDomain: "test", coupling: "conducted-shielded", radiated: false, iq: false, input: "real-rspdx-normalized-uint8" },
    prerequisites: V6_PREREQUISITE_GATES.map((gate) => ({
      gate,
      decision: "passed",
      completedAt: TIMES.prerequisite,
      artifactPath: `prerequisites/${gate}.json`,
      artifactSha256: "0".repeat(64),
      release: RELEASE,
      configurationSha256: CANDIDATE.configurationSha256,
    })),
    equipment: ["signal-generator", "frequency-power-reference", "attenuation-path"].map((role, index) => ({
      equipmentId: `equipment-${index + 1}`,
      role: role as "signal-generator" | "frequency-power-reference" | "attenuation-path",
      modelSha256: identity(`${role}-model`),
      serialSha256: identity(`${role}-serial`),
      certificatePath: `certificates/equipment-${index + 1}.txt`,
      certificateSha256: "0".repeat(64),
      certificateIdSha256: identity(`${role}-certificate-id`),
      calibrated: true,
      calibrationValidFrom: "2025-01-01T00:00:00.000Z",
      calibrationValidUntil: "2027-01-01T00:00:00.000Z",
      statedUncertainty: "Test fixture only; frequency 10 Hz, source level 0.5 dB at generator reference port.",
    })),
    matrix,
    acceptance: { independentRunsPerTargetCase: 10, unknownCanPass: false, guardOrShamAlertAllowed: false, overloadMustBeSeparate: true },
  };
  const acquisitions = new Map<string, V6AcquisitionDescriptor>();
  const rawTables = new Map<string, V6RawMeasurementTable>();
  matrix.forEach((entry, index) => {
    acquisitions.set(entry.caseId, acquisitionFor(binding, campaignId, entry, index));
    rawTables.set(entry.caseId, rawFor(binding, campaignId, entry));
  });
  options.mutate?.({ binding, protocol, acquisitions, rawTables });
  const files: V6CampaignFileEntry[] = [];
  for (const prerequisite of protocol.prerequisites) {
    const sources: V6PrerequisiteSourceReference[] = [];
    const writeSource = async (role: V6PrerequisiteSourceReference["role"], value: unknown): Promise<V6CampaignFileEntry> => {
      const artifactPath = `prerequisites/${prerequisite.gate}/${role}.json`;
      const payload = options.forgedPassStubGate === prerequisite.gate
        ? { gate: prerequisite.gate, decision: "passed", release: prerequisite.release, configurationSha256: prerequisite.configurationSha256 }
        : value;
      const written = await writePayload(root, artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
      sources.push({ role, artifactPath, artifactSha256: written.sha256 });
      files.push(written);
      return written;
    };
    if (prerequisite.gate === "V0") {
      await writeSource("traceability-report", {
        schemaVersion: 2,
        valid: true,
        qualificationGates: Array.from({ length: 8 }, (_, index) => `V${index}`),
        releaseBinding: { state: "verified", buildId: RELEASE.buildId, sourceDigest: RELEASE.sourceDigest, packageDigest: RELEASE.packageDigest },
      });
    } else if (prerequisite.gate === "V1") {
      await writeSource("validation-record", {
        schemaVersion: 1,
        recordType: "rf-monitor-validation",
        gate: "V1",
        release: RELEASE,
        result: { state: "passed", softwareGatePassed: true, productionReady: false, physicalQualification: "not-run" },
        testSummary: { failedTests: 0, skippedTests: 0, failedTestFiles: 0, skippedTestFiles: 0 },
      });
    } else if (prerequisite.gate === "V2") {
      await writeSource("qualification-record", {
        schemaVersion: 1,
        gate: "V2",
        qualification: "packaged-process-and-storage-boundaries",
        result: "PASS",
        softwareQualificationOnly: true,
        productionQualified: false,
        release: RELEASE,
      });
    } else if (prerequisite.gate === "V3") {
      await writeSource("browser-result", {
        schemaVersion: 1,
        recordType: "rf-monitor-v3-packaged-browser-result",
        gate: "V3",
        packaged: true,
        configurationSha256: CANDIDATE.configurationSha256,
        release: RELEASE,
        result: { gateDecision: "passed", productionReady: false },
        accessibility: { violations: 0 },
        operatorWorkflowsPassed: true,
      });
    } else if (prerequisite.gate === "V4") {
      const packaged = await writeSource("packaged-result", {
        schemaVersion: 1,
        recordType: "rf-monitor-v4-packaged-end-to-end-result",
        release: { before: RELEASE, after: RELEASE, unchanged: true },
        result: { packagedEndToEndSubGate: "passed", overallV4: "not-passed", productionReady: false },
      });
      const detector = await writeSource("detector-result", {
        schemaVersion: 1,
        recordType: "rf-monitor-v4-detector-campaign-result",
        executedCases: 16_040,
        candidate: { before: RELEASE, after: RELEASE, unchanged: true },
        result: { detectorStatisticalSubGate: "passed", overallV4: "not-passed", productionReady: false },
      });
      await writeSource("combined-result", {
        schemaVersion: 1,
        recordType: "rf-monitor-v4-combined-result",
        gate: "V4",
        configurationSha256: CANDIDATE.configurationSha256,
        release: RELEASE,
        packagedResultSha256: packaged.sha256,
        detectorResultSha256: detector.sha256,
        detectorCases: 16_040,
        result: { gateDecision: "passed", productionReady: false },
      });
    } else {
      const replayReportValue = {
        schemaVersion: 1,
        recordType: "rf-monitor-v5-held-out-replay-result",
        gate: "V5",
        release: RELEASE,
        externalWitness: { signatureVerified: true, keySha256: identity("v5-original-witness-key") },
        result: { gateDecision: "passed", allCriteriaPassed: true, corpusUnchanged: true, fieldTreeUnchanged: true, thresholdMutationDetected: false, productionReady: false },
      };
      const replayReportBytes = `${JSON.stringify(replayReportValue, null, 2)}\n`;
      const replayReportHash = hash(replayReportBytes);
      const bundle = await writeSource("bundle-manifest", {
        schemaVersion: 1,
        recordType: "rf-monitor-v5-held-out-replay-bundle",
        gate: "V5",
        gateDecision: "passed",
        productionReady: false,
        release: RELEASE,
        files: [{ path: "report.json", bytes: Buffer.byteLength(replayReportBytes), sha256: replayReportHash }],
      });
      const report = await writeSource("replay-result", replayReportValue);
      const verificationStatement = createV5IndependentVerificationStatement({
        verifiedAt: TIMES.prerequisite,
        release: RELEASE,
        configurationSha256: CANDIDATE.configurationSha256,
        bundleManifestSha256: bundle.sha256,
        reportSha256: report.sha256,
        v5WitnessKeySha256: replayReportValue.externalWitness.keySha256,
        verifierIdentitySha256: protocol.v5ReplayVerification.verifierIdentitySha256,
      });
      const verifierPrivateKey = options.forgeV5VerifierSignature ? generateKeyPairSync("ed25519").privateKey : V5_VERIFIER_KEYS.privateKey;
      await writeSource("verification-record", {
        schemaVersion: 1,
        recordType: "rf-monitor-v5-replay-verification",
        publicKeyPem: V5_VERIFIER_PUBLIC_KEY,
        verifierKeySha256: V5_VERIFIER_KEY_SHA256,
        statement: verificationStatement,
        statementSha256: sha256CanonicalV6(verificationStatement),
        signatureAlgorithm: "ed25519",
        signatureBase64: sign(null, v5IndependentVerifierMessage(verificationStatement), verifierPrivateKey).toString("base64"),
      });
    }
    expect(sources.map((source) => source.role)).toEqual([...V6_PREREQUISITE_SOURCE_ROLES[prerequisite.gate]]);
    const wrapper: V6PrerequisiteWrapper = {
      schemaVersion: 1,
      recordType: "rf-monitor-v6-prerequisite-wrapper",
      gate: prerequisite.gate,
      decision: "passed",
      completedAt: prerequisite.completedAt,
      release: prerequisite.release,
      configurationSha256: prerequisite.configurationSha256,
      sources,
      sourceSetSha256: v6PrerequisiteSourceSetFingerprint(sources),
    };
    const written = await writePayload(root, prerequisite.artifactPath, `${JSON.stringify(wrapper, null, 2)}\n`);
    prerequisite.artifactSha256 = written.sha256;
    files.push(written);
  }
  for (const equipment of protocol.equipment) {
    const written = await writePayload(root, equipment.certificatePath, `TEST FRAMEWORK CERTIFICATE ${equipment.equipmentId}\n`);
    equipment.certificateSha256 = written.sha256;
    files.push(written);
  }
  const scoreInputs: Array<{ entry: V6MatrixCase; raw: V6RawMeasurementTable }> = [];
  for (const entry of protocol.matrix) {
    const descriptor = acquisitions.get(entry.caseId)!;
    const raw = rawTables.get(entry.caseId)!;
    files.push(await writePayload(root, entry.acquisitionDescriptorPath, `${JSON.stringify(descriptor)}\n`));
    files.push(await writePayload(root, entry.rawTablePath, `${JSON.stringify(raw)}\n`));
    files.push(await writePayload(root, entry.evidencePath, `TEST FRAMEWORK EVIDENCE ${entry.caseId}\n`));
    files.push(await writePayload(root, descriptor.fft.path, new Uint8Array(descriptor.fft.bytes).fill(30)));
    scoreInputs.push({ entry, raw });
  }
  const protocolBytes = `${JSON.stringify(protocol, null, 2)}\n`;
  const protocolEntry = await writePayload(root, "protocol.json", protocolBytes);
  files.push(protocolEntry);
  const scores = scoreInputs.map(({ entry, raw }) => scoreV6MeasurementCase(entry, raw, binding.targets.find((target) => target.targetId === entry.targetId)!));
  const decision = scores.every((score) => score.passed) ? "passed" : "failed";
  const finalExposure = Math.max(...protocol.matrix.map((entry) => Date.parse(acquisitions.get(entry.caseId)!.lastExposureAt)));
  const declared: V6DeclaredResult = {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-declared-result",
    campaignId,
    protocolSha256: protocolEntry.sha256,
    completedAt: new Date(Math.max(Date.parse(TIMES.completed), finalExposure + 1_000)).toISOString(),
    expectedCases: scores.length,
    caseResultSha256: v6CaseResultFingerprint(scores),
    decision,
  };
  const declaredEntry = await writePayload(root, "declared-result.json", `${JSON.stringify(declared, null, 2)}\n`);
  files.push(declaredEntry);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const treeSha256 = sha256CanonicalV6(files);
  const firstExposureAt = new Date(Math.min(...protocol.matrix.map((entry) => Date.parse(acquisitions.get(entry.caseId)!.firstExposureAt)))).toISOString();
  const lastExposureAt = new Date(finalExposure).toISOString();
  const protocolStatement = createV6ProtocolWitnessStatement({
    campaignId,
    protocolSha256: protocolEntry.sha256,
    approvedBindingSha256: bindingSha256,
    protocolCommittedAt: protocol.committedAt,
    signedAt: TIMES.protocolSigned,
    firstExposureNotBefore: firstExposureAt,
    ...protocol.identities,
  });
  const finalSignedAt = new Date(Math.max(Date.parse(TIMES.finalSigned), Date.parse(declared.completedAt) + 1_000)).toISOString();
  const finalStatement = createV6FinalWitnessStatement({
    campaignId,
    protocolSha256: protocolEntry.sha256,
    evidenceTreeSha256: treeSha256,
    declaredResultSha256: declaredEntry.sha256,
    caseResultSha256: declared.caseResultSha256,
    declaredDecision: declared.decision,
    firstExposureAt,
    lastExposureAt,
    signedAt: finalSignedAt,
    ...protocol.identities,
  });
  const privateKey = options.privateKey ?? KEYS.privateKey;
  const envelope = <T extends typeof protocolStatement | typeof finalStatement>(receiptId: string, statement: T) => ({
    receiptId,
    statement,
    statementSha256: sha256CanonicalV6(statement),
    keySha256: KEY_SHA256,
    signatureAlgorithm: "ed25519" as const,
    signatureBase64: sign(null, v6WitnessMessage(statement), privateKey).toString("base64"),
  });
  const manifest: V6CampaignManifest = {
    schemaVersion: 1,
    recordType: "rf-monitor-v6-conducted-campaign",
    frameworkVersion: V6_CONDUCTED_FRAMEWORK_VERSION,
    campaignId,
    createdAt: finalSignedAt,
    protocol: { path: "protocol.json", sha256: protocolEntry.sha256 },
    declaredResult: { path: "declared-result.json", sha256: declaredEntry.sha256 },
    files,
    evidenceTreeSha256: treeSha256,
    protocolWitness: envelope("v6-protocol-receipt", protocolStatement),
    finalWitness: envelope("v6-final-receipt", finalStatement),
  };
  await writeFile(path.join(root, "campaign-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await makeReadOnly(root);
  return { root, binding, bindingSha256, protocol };
}

let temporaryRoot = "";
let validFixture: Awaited<ReturnType<typeof buildFixture>>;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v6-"));
  validFixture = await buildFixture(path.join(temporaryRoot, "valid"));
}, 120_000);

afterAll(async () => {
  await makeWritable(temporaryRoot).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
});

function runOptions(fixture: Awaited<ReturnType<typeof buildFixture>>) {
  return {
    campaignRoot: fixture.root,
    candidate: CANDIDATE,
    approvedBinding: fixture.binding,
    approvedBindingSha256: fixture.bindingSha256,
    witness: WITNESS,
    now: () => new Date("2026-01-06T00:00:00.000Z"),
    runId: "fixture-run",
  } as const;
}

describe("V6 conducted installed-chain qualification framework", () => {
  it("mechanically scores the complete witnessed framework fixture without claiming production readiness", async () => {
    const report = await runV6ConductedQualification(runOptions(validFixture));
    expect(report.result).toMatchObject({ gateDecision: "passed", completeMatrix: true, prerequisiteGatesPassed: true, calibratedEquipmentInDate: true, fieldDataWritten: false, productionReady: false });
    expect(report.counts).toEqual({ cases: 360, passed: 360, failed: 0, unknown: 0 });
    expect(report.byTargetKind).toHaveLength(36);
    expect(report.testedEnvelope).toHaveLength(36);
    expect(report.limitations.join(" ")).toMatch(/cannot prove.*physical/i);
    expect(report.limitations.join(" ")).toMatch(/does not classify spoofing/i);
  }, 120_000);

  it("rejects the wrong externally pinned witness key", async () => {
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(runV6ConductedQualification({ ...runOptions(validFixture), witness: { publicKeyPem: wrong, expectedKeySha256: v6WitnessKeyFingerprint(wrong) } })).rejects.toThrow(/key or algorithm mismatch/);
  }, 120_000);

  it("rejects stale candidate, configuration, installed chain, and prerequisite bindings", async () => {
    await expect(runV6ConductedQualification({ ...runOptions(validFixture), candidate: { ...CANDIDATE, configurationSha256: "9".repeat(64) } })).rejects.toThrow(/configuration or catalog is stale/);
    const stale = await buildFixture(path.join(temporaryRoot, "stale-prerequisite"), {
      mutate: ({ protocol }) => { protocol.prerequisites[0].configurationSha256 = "8".repeat(64); },
    });
    await expect(runV6ConductedQualification(runOptions(stale))).rejects.toThrow(/prerequisite V0 is stale/);
    const chain = await buildFixture(path.join(temporaryRoot, "stale-chain"), {
      mutate: ({ acquisitions }) => { acquisitions.values().next().value!.source.installedChainFingerprintSha256 = "7".repeat(64); },
    });
    await expect(runV6ConductedQualification(runOptions(chain))).rejects.toThrow(/RF-chain binding is stale/);
  }, 120_000);

  it("rejects a fully rehashed and re-signed generic prerequisite PASS stub", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "forged-pass-stub"), { forgedPassStubGate: "V2" });
    await expect(runV6ConductedQualification(runOptions(fixture))).rejects.toThrow(/V2 source is not the packaged process\/storage PASS record/);
  }, 120_000);

  it("rejects a rehashed V5 verifier record signed by an unpinned key", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "forged-v5-verifier"), { forgeV5VerifierSignature: true });
    await expect(runV6ConductedQualification(runOptions(fixture))).rejects.toThrow(/V5 independent verifier signature verification failed/);
  }, 120_000);

  it("rejects expired calibration certificates even when their files hash correctly", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "expired-calibration"), {
      mutate: ({ protocol }) => { protocol.equipment[0].calibrationValidUntil = "2025-12-31T00:00:00.000Z"; },
    });
    await expect(runV6ConductedQualification(runOptions(fixture))).rejects.toThrow(/calibration expired/);
  }, 120_000);

  it("rejects a symlink anywhere in the sealed campaign tree", async () => {
    const clone = path.join(temporaryRoot, "symlink");
    await cp(validFixture.root, clone, { recursive: true });
    await makeWritable(clone);
    const target = path.join(clone, "prerequisites", "V0.json");
    await rm(target);
    await symlink(path.join(validFixture.root, "prerequisites", "V0.json"), target);
    await makeReadOnly(clone);
    await expect(runV6ConductedQualification({ ...runOptions(validFixture), campaignRoot: clone })).rejects.toThrow(/symlink/);
  }, 120_000);

  it("rejects mutation after sealing", async () => {
    const clone = path.join(temporaryRoot, "mutation");
    await cp(validFixture.root, clone, { recursive: true });
    await makeWritable(clone);
    const target = path.join(clone, "acquisitions", validFixture.protocol.matrix[0].caseId, "evidence.txt");
    await writeFile(target, "MUTATED\n");
    await makeReadOnly(clone);
    await expect(runV6ConductedQualification({ ...runOptions(validFixture), campaignRoot: clone })).rejects.toThrow(/changed or does not match/);
  }, 120_000);

  it("rejects an incomplete predeclared Tier-1 matrix", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "incomplete"), {
      mutate: ({ protocol }) => { protocol.matrix.pop(); },
    });
    await expect(runV6ConductedQualification(runOptions(fixture))).rejects.toThrow(/matrix is incomplete/);
  }, 120_000);

  it("scores unknown as failure rather than clean", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "unknown"), {
      mutate: ({ protocol, rawTables }) => {
        const entry = protocol.matrix.find((candidate) => candidate.kind === "wideband")!;
        const raw = rawTables.get(entry.caseId)!;
        raw.observation.outcome = "unknown";
        raw.observation.alertKinds = [];
        raw.observation.attributedTargetId = null;
      },
    });
    const report = await runV6ConductedQualification(runOptions(fixture));
    expect(report.result.gateDecision).toBe("failed");
    expect(report.counts.unknown).toBe(1);
    expect(report.cases.find((entry) => entry.observedOutcome === "unknown")?.failureReasons).toContain("unknown-cannot-pass");
  }, 120_000);

  it("fails unexplained guard/sham alerts and an overload labelled as interference", async () => {
    const fixture = await buildFixture(path.join(temporaryRoot, "physical-failures"), {
      mutate: ({ protocol, rawTables }) => {
        for (const kind of ["guard-only", "sham"] as const) {
          const entry = protocol.matrix.find((candidate) => candidate.kind === kind)!;
          const raw = rawTables.get(entry.caseId)!;
          raw.observation.outcome = "alert";
          raw.observation.attributedTargetId = entry.targetId;
          raw.observation.alertKinds = ["wideband-rise"];
        }
        const overload = protocol.matrix.find((candidate) => candidate.kind === "overload")!;
        const raw = rawTables.get(overload.caseId)!;
        raw.observation.outcome = "alert";
        raw.observation.alertKinds = ["wideband-rise"];
        raw.observation.overloadObserved = true;
      },
    });
    const report = await runV6ConductedQualification(runOptions(fixture));
    expect(report.result.gateDecision).toBe("failed");
    expect(report.cases.find((entry) => entry.kind === "guard-only" && !entry.passed)?.failureReasons).toContain("guard-only-unexpected-alert");
    expect(report.cases.find((entry) => entry.kind === "sham" && !entry.passed)?.failureReasons).toContain("sham-unexpected-alert");
    expect(report.cases.find((entry) => entry.kind === "overload" && !entry.passed)?.failureReasons).toContain("overload-not-separated");
  }, 120_000);

  it("rejects radiated, IQ, simulation, replay, and field-domain acquisitions", async () => {
    const violations: Array<[string, (descriptor: V6AcquisitionDescriptor) => void]> = [
      ["radiated", (descriptor) => { (descriptor.source as { radiated: boolean }).radiated = true; }],
      ["IQ", (descriptor) => { (descriptor.source as { iq: boolean }).iq = true; }],
      ["simulation", (descriptor) => { (descriptor.source as { simulation: boolean }).simulation = true; }],
      ["replay", (descriptor) => { (descriptor.source as { replay: boolean }).replay = true; }],
      ["field", (descriptor) => { (descriptor.source as { dataDomain: string }).dataDomain = "field"; }],
    ];
    for (const [name, mutate] of violations) {
      const fixture = await buildFixture(path.join(temporaryRoot, `domain-${name}`), {
        mutate: ({ acquisitions }) => mutate(acquisitions.values().next().value!),
      });
      await expect(runV6ConductedQualification(runOptions(fixture))).rejects.toThrow(/violates the real conducted\/shielded test-domain boundary/);
    }
  }, 180_000);

  it("writes an atomic read-only bundle, verifies it, and forbids overwrite", async () => {
    const report = await runV6ConductedQualification(runOptions(validFixture));
    const output = path.join(temporaryRoot, "output");
    const bundle = await writeV6ConductedBundle(output, report);
    await expect(verifyV6ConductedBundle(bundle, WITNESS)).resolves.toMatchObject({ outcome: "PASS", gateDecision: "passed", campaignId: report.campaignId, witnessKeySha256: KEY_SHA256 });
    await makeWritable(bundle);
    const reportPath = path.join(bundle, "report.json");
    const manifestPath = path.join(bundle, "manifest.json");
    const tamperedReport = JSON.parse(await readFile(reportPath, "utf8")) as typeof report;
    tamperedReport.cases[0].measured.sourceLevelDbmAtGeneratorPort = -10;
    tamperedReport.deterministicResultHash = sha256CanonicalV6({ release: tamperedReport.release, approvedBindingSha256: tamperedReport.approvedBindingSha256, campaignId: tamperedReport.campaignId, protocolSha256: tamperedReport.campaign.protocolSha256, evidenceTreeSha256: tamperedReport.campaign.evidenceTreeSha256, scores: tamperedReport.cases, decision: tamperedReport.result.gateDecision });
    const reportBytes = Buffer.from(`${JSON.stringify(tamperedReport, null, 2)}\n`);
    await writeFile(reportPath, reportBytes);
    const tamperedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Array<{ path: string; sha256: string; bytes: number }> };
    tamperedManifest.files[0].sha256 = hash(reportBytes);
    tamperedManifest.files[0].bytes = reportBytes.byteLength;
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    await makeReadOnly(bundle);
    await expect(verifyV6ConductedBundle(bundle, WITNESS)).rejects.toThrow(/cryptographically bound/);
    await expect(writeV6ConductedBundle(output, report)).rejects.toThrow(/overwrite is forbidden/);
    expect((await readdir(output)).some((entry) => entry.includes(".partial-"))).toBe(false);
  }, 120_000);
});
