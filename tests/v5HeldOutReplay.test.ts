import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import operationalJson from "../config/operational.example.json";
import {
  baselineFingerprintId,
  detectionRuleFingerprint,
} from "../src/shared/detection";
import { detectorQualificationPlan } from "../src/shared/detectorQualification";
import { validateOperationalSettings } from "../src/shared/settings";
import type { BaselineFingerprint, OperationalSettings } from "../src/shared/types";
import { operationalConfigurationHash } from "../src/server/config";
import {
  runV5HeldOutReplay,
  createV5WitnessStatement,
  sha256CanonicalV5,
  validateV5ReplayCorpus,
  V5_REPLAY_FAMILIES,
  V5_REPLAY_FRAMEWORK_VERSION,
  v5WitnessKeyFingerprint,
  v5WitnessMessage,
  verifyV5ReplayBundle,
  verifyV5ReplayBundleAgainstCorpus,
  writeV5ReplayBundle,
  type V5CandidateContext,
  type V5ObservationRecord,
  type V5ReplayCorpusManifest,
  type V5ReplayCriterion,
  type V5ReplayFrozenIdentity,
  type V5ReplayPrecommitment,
  type V5SessionDescriptor,
  type V5TruthDisclosure,
  type V5WitnessContext,
} from "../src/server/heldOutReplayQualification";
import type { FrozenCandidateIdentity } from "../src/server/syntheticQualificationCampaign";
import { TEST_CATALOG } from "./catalogFixture";

const RELEASE: FrozenCandidateIdentity = {
  schemaVersion: 1,
  product: "rf-monitor",
  releaseVersion: "1.0.0-test-fixture",
  buildId: "v5-framework-test-fixture",
  sourceDigest: "1".repeat(64),
  packageDigest: "2".repeat(64),
  dependencyLockDigest: "3".repeat(64),
};

const HASHES = {
  acquisition: createHash("sha256").update("independent acquisition custodian").digest("hex"),
  truth: createHash("sha256").update("independent truth labeler").digest("hex"),
  detector: createHash("sha256").update("detector custodian").digest("hex"),
  serial: createHash("sha256").update("test receiver serial not retained").digest("hex"),
};

const WITNESS_KEYS = generateKeyPairSync("ed25519");
const WITNESS_PUBLIC_PEM = WITNESS_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const WITNESS_KEY_SHA256 = v5WitnessKeyFingerprint(WITNESS_PUBLIC_PEM);
const WITNESS: V5WitnessContext = { publicKeyPem: WITNESS_PUBLIC_PEM, expectedKeySha256: WITNESS_KEY_SHA256 };
const WITNESS_SIGNED_AT = "2026-01-04T00:00:00.000Z";

const TIMES = {
  acquisitionClosedAt: "2026-01-01T00:00:00.000Z",
  detectorFrozenAt: "2026-01-02T00:00:00.000Z",
  criteriaCommittedAt: "2026-01-03T00:00:00.000Z",
  truthCommittedAt: "2026-01-03T00:00:00.000Z",
  unblindedAt: "2026-01-05T00:00:00.000Z",
  corpusSealedAt: "2026-01-06T00:00:00.000Z",
} as const;

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const operational = validateOperationalSettings(operationalJson as OperationalSettings, TEST_CATALOG);
const candidate: V5CandidateContext = {
  release: RELEASE,
  catalog: TEST_CATALOG,
  operationalSettings: operational,
  configurationHash: operationalConfigurationHash(operational, TEST_CATALOG.catalogVersion),
  catalogHash: sha256CanonicalV5(TEST_CATALOG),
  detectorRuleHash: detectionRuleFingerprint(operational.detection),
};

function expectedOutcome(family: typeof V5_REPLAY_FAMILIES[number]): "alert" | "no-alert" | "unknown" {
  if (["data-gap", "configuration-change"].includes(family)) return "unknown";
  if (["matched-power-spoofing", "replay-nuisance"].includes(family)) return "no-alert";
  return "alert";
}

async function put(root: string, relative: string, bytes: string | Uint8Array): Promise<void> {
  const filePath = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

function observationsFor(outcome: "alert" | "no-alert" | "unknown", inputBinCount: number): { records: V5ObservationRecord[]; fft: Uint8Array } {
  if (outcome === "unknown") return {
    records: [{
      schemaVersion: 1,
      sequence: 0,
      outcome: "unknown",
      observedAt: "2026-01-10T00:00:04.500Z",
      startMonotonicMs: 0,
      endMonotonicMs: 4_500,
      reason: "configuration-changed",
      intentionalDiscardedFrames: 0,
    }],
    fft: new Uint8Array(),
  };
  const records: V5ObservationRecord[] = [];
  const fft = new Uint8Array(inputBinCount * 3);
  for (let sequence = 0; sequence < 3; sequence += 1) {
    const firstMonotonicMs = sequence * 1_500;
    const lastMonotonicMs = firstMonotonicMs + 1_000;
    const bins = new Uint8Array(inputBinCount).fill(30);
    if (outcome === "alert") bins.fill(100, 2, 14);
    fft.set(bins, sequence * inputBinCount);
    records.push({
      schemaVersion: 1,
      sequence,
      outcome: "valid",
      visitId: `visit-${sequence}`,
      observedAt: new Date(Date.parse("2026-01-10T00:00:00.000Z") + lastMonotonicMs).toISOString(),
      firstMonotonicMs,
      lastMonotonicMs,
      exposureMs: 1_000,
      acceptedFrameCount: 3,
      intentionalDiscardedFrames: 2,
      rawOffset: sequence * inputBinCount,
      rawLength: inputBinCount,
      configurationEpoch: 1,
      tuneEpoch: sequence + 1,
      visitEpoch: sequence + 1,
      confirmedCenterHz: 0,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(Date.parse("2026-01-10T00:00:00.000Z") + Math.max(0, firstMonotonicMs - 250)).toISOString(),
      overload: false,
      healthComplete: true,
    });
  }
  return { records, fft };
}

async function createCorpus(root: string): Promise<{ manifest: V5ReplayCorpusManifest; sessionDescriptorPath: string }> {
  await mkdir(root, { recursive: true });
  const plan = detectorQualificationPlan(TEST_CATALOG);
  const frozen: V5ReplayFrozenIdentity = {
    release: RELEASE,
    configurationHash: candidate.configurationHash,
    catalogVersion: TEST_CATALOG.catalogVersion,
    catalogHash: candidate.catalogHash,
    detectorVersion: "relative-mad-1",
    detectorRuleSetId: operational.detection.ruleSetId,
    detectorRuleHash: candidate.detectorRuleHash,
    detectorThresholds: operational.detection,
    targetIds: plan.targets.map((target) => target.id),
    families: [...V5_REPLAY_FAMILIES],
  };
  const criteria: V5ReplayCriterion[] = [];
  for (const target of plan.targets) for (const family of V5_REPLAY_FAMILIES) {
    const criterionId = `${target.id}-${family}`;
    criteria.push({
      criterionId,
      targetId: target.id,
      family,
      expectedOutcome: expectedOutcome(family),
      sessionIds: Array.from({ length: 30 }, (_, index) => `${criterionId}-${String(index).padStart(2, "0")}`),
      minimumIndependentSessions: 30,
      requiredWilsonLowerBound: expectedOutcome(family) === "unknown" ? null : 0.9,
      maximumUnknownFraction: 0,
      maximumUnobservedFraction: 0,
      testedEnvelope: {
        envelopeId: `envelope-${target.id}-${family}`,
        description: `Test-only real-FFT-shaped framework fixture for ${target.id}/${family}`,
        parameters: { fixtureOnly: true, inputEncoding: "uint8", family },
      },
    });
  }

  const sessions: V5ReplayPrecommitment["sessions"] = [];
  const inputBinCount = 16;
  const analysisStartBin = 2;
  const analysisEndBin = 14;
  const analysisBins = analysisEndBin - analysisStartBin;
  const analysisMaskHash = sha256CanonicalV5({ inputBinCount, analysisStartBin, analysisEndBin, analysisSpanHz: 8_000_000, captureSpanHz: 10_000_000 });
  for (const target of plan.targets) {
    await put(root, `baselines/${target.id}/baseline-medians.uint8`, new Uint8Array(analysisBins).fill(30));
    await put(root, `baselines/${target.id}/baseline-mads.uint8`, new Uint8Array(analysisBins).fill(1));
  }

  let firstDescriptorPath = "";
  for (const criterion of criteria) for (const sessionId of criterion.sessionIds) {
    const target = TEST_CATALOG.captureTargets.find((candidateTarget) => candidateTarget.id === criterion.targetId)!;
    const directory = `sessions/${sessionId}`;
    const descriptorPath = `${directory}/session.json`;
    if (!firstDescriptorPath) firstDescriptorPath = descriptorPath;
    const truth: V5TruthDisclosure = {
      schemaVersion: 1,
      recordType: "rf-monitor-v5-held-out-truth",
      sessionId,
      criterionId: criterion.criterionId,
      targetId: criterion.targetId,
      family: criterion.family,
      expectedOutcome: criterion.expectedOutcome,
      eventWindow: { startMonotonicMs: 0, endMonotonicMs: 4_500, alertGraceMs: 500 },
      envelopeId: criterion.testedEnvelope.envelopeId,
      withinPredeclaredEnvelope: true,
      measuredParameters: { fixtureOnly: true, normalizedLevel: criterion.expectedOutcome === "alert" ? 100 : 30 },
      truthLabelerIdHash: HASHES.truth,
      committedAt: TIMES.truthCommittedAt,
      nonce: sha256(`truth-nonce:${sessionId}`),
    };
    const truthCommitment = sha256CanonicalV5(truth);
    const generated = observationsFor(criterion.expectedOutcome, inputBinCount);
    for (const record of generated.records) if (record.outcome === "valid") {
      record.confirmedCenterHz = target.centerHz;
      record.overload = criterion.family === "overload";
    } else if (criterion.family === "data-gap") record.reason = "insufficient-frames";
    const observationsJsonl = `${generated.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const fingerprint: BaselineFingerprint = {
      schemaVersion: 1,
      detectorVersion: frozen.detectorVersion,
      detectionRuleHash: frozen.detectorRuleHash,
      dataDomain: "field",
      receiverIdentity: `hardware:RSPdx R2:${HASHES.serial}`,
      receiverKey: `rspdx:${HASHES.serial}`,
      deviceName: "RSPdx R2",
      sdrconnectVersion: "1.2.3-held-out-fixture",
      activeAntenna: "held-out-antenna-fixture",
      gainProfileId: "fixed-gain-fixture",
      targetId: target.id,
      centerHz: target.centerHz,
      sampleRateHz: 10_000_000,
      inputBinCount,
      analysisStartBin,
      analysisEndBin,
      analysisMaskHash,
      spectrumReference: 0,
      spectrumBase: 0,
      catalogVersion: TEST_CATALOG.catalogVersion,
    };
    const fingerprintId = baselineFingerprintId(fingerprint);
    const descriptor: V5SessionDescriptor = {
      schemaVersion: 1,
      recordType: "rf-monitor-v5-held-out-fft-session",
      sessionId,
      acquisitionId: `acquisition-${sessionId}`,
      criterionId: criterion.criterionId,
      independentSession: true,
      source: {
        kind: "real-receiver-normalized-fft",
        acquisitionDataDomain: "field",
        normalizedEncoding: "uint8",
        realReceiver: true,
        synthetic: false,
        simulation: false,
        replay: false,
        iq: false,
      },
      receiver: { model: "RSPdx R2", serialSha256: HASHES.serial },
      sdrconnect: { version: fingerprint.sdrconnectVersion, sampleRateReadBackConfirmed: true, fftValues: "normalized-uint8-display-values" },
      target: {
        id: target.id,
        label: target.label,
        bandId: target.relatedBandIds[0],
        affectedBandIds: [...target.relatedBandIds],
        centerHz: target.centerHz,
        captureSpanHz: target.captureSpanHz,
        analysisSpanHz: target.analysisSpanHz,
      },
      grid: { sampleRateHz: 10_000_000, inputBinCount, analysisStartBin, analysisEndBin, analysisMaskHash, spectrumReference: 0, spectrumBase: 0 },
      fingerprint,
      fingerprintId,
      baseline: {
        descriptor: {
          dataDomain: "field",
          targetId: target.id,
          lifecycle: "protected",
          fingerprintId,
          baselineId: `baseline-${target.id}`,
          learningGenerationId: `generation-${target.id}`,
          observationCount: 256,
          validCoverageRatio: 1,
          representativeHours: 24,
          learningStartedAt: "2025-12-01T00:00:00.000Z",
          protectedAt: "2025-12-03T00:00:00.000Z",
        },
        mediansPath: `baselines/${target.id}/baseline-medians.uint8`,
        madsPath: `baselines/${target.id}/baseline-mads.uint8`,
      },
      observations: {
        indexPath: `${directory}/observations.jsonl`,
        fftPath: `${directory}/fft.uint8`,
        recordCount: generated.records.length,
        validRecordCount: generated.records.filter((record) => record.outcome === "valid").length,
        unknownRecordCount: generated.records.filter((record) => record.outcome === "unknown").length,
      },
      truth: { disclosurePath: `${directory}/truth.json`, commitment: truthCommitment, commitmentAlgorithm: "sha256-canonical-json" },
    };
    const descriptorBytes = `${JSON.stringify(descriptor, null, 2)}\n`;
    await put(root, descriptor.truth.disclosurePath, `${JSON.stringify(truth, null, 2)}\n`);
    await put(root, descriptor.observations.indexPath, observationsJsonl);
    await put(root, descriptor.observations.fftPath, generated.fft);
    await put(root, descriptorPath, descriptorBytes);
    sessions.push({ sessionId, criterionId: criterion.criterionId, descriptorPath, descriptorSha256: sha256(descriptorBytes), truthCommitment });
  }

  const precommitment: V5ReplayPrecommitment = {
    schemaVersion: 1,
    recordType: "rf-monitor-v5-held-out-precommitment",
    corpusId: "v5-framework-test-corpus",
    committedAt: TIMES.criteriaCommittedAt,
    frozen,
    criteria,
    sessions,
    custody: {
      acquisitionCustodianIdHash: HASHES.acquisition,
      truthLabelerIdHash: HASHES.truth,
      detectorCustodianIdHash: HASHES.detector,
    },
    nonce: sha256("precommitment nonce"),
  };
  const precommitmentBytes = `${JSON.stringify(precommitment, null, 2)}\n`;
  await put(root, "precommitment.json", precommitmentBytes);

  const diskFiles: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else diskFiles.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  const files = await Promise.all(diskFiles.sort().map(async (relative) => {
    const bytes = await readFile(path.join(root, ...relative.split("/")));
    return { path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
  const precommitmentSha256 = sha256(precommitmentBytes);
  const witnessStatement = createV5WitnessStatement({
    corpusId: precommitment.corpusId,
    precommitmentSha256,
    precommitmentCommittedAt: precommitment.committedAt,
    signedAt: WITNESS_SIGNED_AT,
    unblindingNotBefore: TIMES.unblindedAt,
  });
  const manifest: V5ReplayCorpusManifest = {
    schemaVersion: 1,
    recordType: "rf-monitor-v5-held-out-fft-corpus",
    frameworkVersion: V5_REPLAY_FRAMEWORK_VERSION,
    corpusId: precommitment.corpusId,
    corpusPurpose: "external-held-out-qualification",
    acquisitionDataDomain: "field",
    replayDataDomain: "test",
    createdAt: TIMES.corpusSealedAt,
    custody: {
      ...TIMES,
      acquisitionCustodianIdHash: HASHES.acquisition,
      truthLabelerIdHash: HASHES.truth,
      detectorCustodianIdHash: HASHES.detector,
      independentTruthLabels: true,
      holdoutNotUsedForTuning: true,
      thresholdsFrozenBeforeUnblinding: true,
    },
    frozen,
    criteria,
    sessions,
    precommitment: { path: "precommitment.json", sha256: precommitmentSha256 },
    externalWitness: {
      receiptId: "v5-framework-test-witness-receipt",
      keySha256: WITNESS_KEY_SHA256,
      signedAt: WITNESS_SIGNED_AT,
      unblindingNotBefore: TIMES.unblindedAt,
      statementSha256: sha256CanonicalV5(witnessStatement),
      signatureAlgorithm: "ed25519",
      signatureBase64: sign(null, v5WitnessMessage(witnessStatement), WITNESS_KEYS.privateKey).toString("base64"),
    },
    files,
    corpusTreeSha256: sha256CanonicalV5(files),
  };
  await put(root, "corpus-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, sessionDescriptorPath: firstDescriptorPath };
}

async function resealCorpus(root: string, changedDescriptorPath?: string): Promise<V5ReplayCorpusManifest> {
  const manifestPath = path.join(root, "corpus-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as V5ReplayCorpusManifest;
  const precommitmentPath = path.join(root, ...manifest.precommitment.path.split("/"));
  const precommitment = JSON.parse(await readFile(precommitmentPath, "utf8")) as V5ReplayPrecommitment;
  if (changedDescriptorPath) {
    const descriptorBytes = await readFile(path.join(root, ...changedDescriptorPath.split("/")));
    const descriptorHash = sha256(descriptorBytes);
    const manifestEntry = manifest.sessions.find((entry) => entry.descriptorPath === changedDescriptorPath)!;
    const commitmentEntry = precommitment.sessions.find((entry) => entry.descriptorPath === changedDescriptorPath)!;
    manifestEntry.descriptorSha256 = descriptorHash;
    commitmentEntry.descriptorSha256 = descriptorHash;
    await writeFile(precommitmentPath, `${JSON.stringify(precommitment, null, 2)}\n`);
  }
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(root, ...entry.path.split("/")));
    entry.bytes = bytes.byteLength;
    entry.sha256 = sha256(bytes);
  }
  manifest.precommitment.sha256 = manifest.files.find((entry) => entry.path === manifest.precommitment.path)!.sha256;
  const witnessStatement = createV5WitnessStatement({
    corpusId: manifest.corpusId,
    precommitmentSha256: manifest.precommitment.sha256,
    precommitmentCommittedAt: precommitment.committedAt,
    signedAt: manifest.externalWitness.signedAt,
    unblindingNotBefore: manifest.externalWitness.unblindingNotBefore,
  });
  manifest.externalWitness.statementSha256 = sha256CanonicalV5(witnessStatement);
  manifest.externalWitness.signatureBase64 = sign(null, v5WitnessMessage(witnessStatement), WITNESS_KEYS.privateKey).toString("base64");
  manifest.corpusTreeSha256 = sha256CanonicalV5(manifest.files.slice().sort((left, right) => left.path.localeCompare(right.path)));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

describe.sequential("V5 held-out replay framework (test fixtures are not V5 evidence)", () => {
  let root = "";
  let corpus = "";
  let field = "";
  let output = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v5-framework-"));
    corpus = path.join(root, "corpus");
    field = path.join(root, "protected-field");
    output = path.join(root, "results");
    await mkdir(field);
    await writeFile(path.join(field, "sentinel.txt"), "field bytes must not change\n");
    await createCorpus(corpus);
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("[framework:V5] validates the sealed corpus and deterministically separates detected, alert-free, unknown, and unobserved sessions", async () => {
    const validation = await validateV5ReplayCorpus(corpus, candidate, WITNESS);
    expect(validation.manifest.sessions).toHaveLength(1_200);
    expect(validation.corpusTreeSha256).toBe(validation.manifest.corpusTreeSha256);

    const first = await runV5HeldOutReplay({ corpusRoot: corpus, protectedFieldRoot: field, candidate, witness: WITNESS, runId: "fixture-run-one", now: () => new Date("2026-02-01T00:00:00.000Z") });
    const second = await runV5HeldOutReplay({ corpusRoot: corpus, protectedFieldRoot: field, candidate, witness: WITNESS, runId: "fixture-run-two", now: () => new Date("2026-02-02T00:00:00.000Z") });
    expect(first.deterministicResultHash).toBe(second.deterministicResultHash);
    expect(first.counts).toEqual({ sessions: 1_200, detected: 720, missed: 0, alertFree: 240, falseAlerts: 0, unknown: 240, unobserved: 0 });
    expect(first.criteria.every((criterion) => criterion.passed)).toBe(true);
    expect(first.criteria.filter((criterion) => criterion.expectedOutcome !== "unknown").every((criterion) => (criterion.interval?.lower ?? 0) >= 0.9)).toBe(true);
    expect(first.result).toEqual({
      gateDecision: "passed",
      allCriteriaPassed: true,
      corpusUnchanged: true,
      fieldTreeUnchanged: true,
      thresholdMutationDetected: false,
      productionReady: false,
    });
    const bundle = await writeV5ReplayBundle(output, first);
    expect(JSON.parse(await readFile(path.join(bundle, "report.json"), "utf8"))).toMatchObject({ gate: "V5", result: { productionReady: false } });
    await expect(verifyV5ReplayBundle(bundle, WITNESS)).resolves.toMatchObject({ outcome: "PASS", gateDecision: "passed", witnessKeySha256: WITNESS_KEY_SHA256 });
    await expect(verifyV5ReplayBundleAgainstCorpus(bundle, {
      corpusRoot: corpus,
      protectedFieldRoot: field,
      candidate,
      witness: WITNESS,
    })).resolves.toMatchObject({ outcome: "PASS", gateDecision: "passed", replayRecomputed: true });
    expect(first.externalWitness).toMatchObject({ keySha256: WITNESS_KEY_SHA256, signatureVerified: true });
    await expect(writeV5ReplayBundle(output, first)).rejects.toThrow(/already exists/);
    expect(await readdir(output)).not.toEqual(expect.arrayContaining([expect.stringContaining(".partial")]));
    const tamperedBundle = path.join(root, "tampered-result-bundle");
    await cp(bundle, tamperedBundle, { recursive: true });
    await chmod(path.join(tamperedBundle, "report.json"), 0o600);
    await writeFile(path.join(tamperedBundle, "report.json"), `${await readFile(path.join(tamperedBundle, "report.json"), "utf8")} `);
    await expect(verifyV5ReplayBundle(tamperedBundle, WITNESS)).rejects.toThrow(/SHA256SUMS mismatch/);
  }, 120_000);

  it("[framework:V5] rejects a self-consistent forged result when independently replayed", async () => {
    const report = await runV5HeldOutReplay({ corpusRoot: corpus, protectedFieldRoot: field, candidate, witness: WITNESS, runId: "authentic-result" });
    const authenticBundle = await writeV5ReplayBundle(output, report);
    const forgedBundle = path.join(root, "forged-result-bundle");
    await cp(authenticBundle, forgedBundle, { recursive: true });
    await chmod(path.join(forgedBundle, "report.json"), 0o600);
    await chmod(path.join(forgedBundle, "manifest.json"), 0o600);
    await chmod(path.join(forgedBundle, "SHA256SUMS"), 0o600);
    const forged = JSON.parse(await readFile(path.join(forgedBundle, "report.json"), "utf8"));
    forged.release.buildId = "forged-build-id";
    const portableTree = (snapshot: Record<string, unknown>) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "root"));
    forged.deterministicResultHash = sha256CanonicalV5({
      frameworkVersion: forged.frameworkVersion,
      release: forged.release,
      corpus: {
        corpusId: forged.corpus.corpusId,
        manifestSha256: forged.corpus.manifestSha256,
        treeSha256: forged.corpus.treeSha256,
        precommitmentSha256: forged.corpus.precommitmentSha256,
      },
      externalWitness: {
        receiptId: forged.externalWitness.receiptId,
        keySha256: forged.externalWitness.keySha256,
        precommitmentCommittedAt: forged.externalWitness.precommitmentCommittedAt,
        signedAt: forged.externalWitness.signedAt,
        unblindingNotBefore: forged.externalWitness.unblindingNotBefore,
        statementSha256: forged.externalWitness.statementSha256,
        signatureAlgorithm: forged.externalWitness.signatureAlgorithm,
        signatureBase64: forged.externalWitness.signatureBase64,
      },
      sessions: forged.sessions,
      criteria: forged.criteria,
      fieldTree: { before: portableTree(forged.isolation.before), after: portableTree(forged.isolation.after) },
    });
    const reportBytes = Buffer.from(`${JSON.stringify(forged, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(path.join(forgedBundle, "manifest.json"), "utf8"));
    manifest.release = forged.release;
    manifest.files[0].bytes = reportBytes.byteLength;
    manifest.files[0].sha256 = sha256(reportBytes);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(forgedBundle, "report.json"), reportBytes);
    await writeFile(path.join(forgedBundle, "manifest.json"), manifestBytes);
    await writeFile(path.join(forgedBundle, "SHA256SUMS"), `${sha256(manifestBytes)}  manifest.json\n${sha256(reportBytes)}  report.json\n`);
    await expect(verifyV5ReplayBundle(forgedBundle, WITNESS)).resolves.toMatchObject({ outcome: "PASS" });
    await expect(verifyV5ReplayBundleAgainstCorpus(forgedBundle, {
      corpusRoot: corpus,
      protectedFieldRoot: field,
      candidate,
      witness: WITNESS,
    })).rejects.toThrow(/do not match an independent replay/);
  }, 120_000);

  it("[framework:V5] rejects a detector-threshold mismatch before replay", async () => {
    const changed = structuredClone(candidate);
    changed.operationalSettings.detection.interferenceSigma += 1;
    changed.detectorRuleHash = detectionRuleFingerprint(changed.operationalSettings.detection);
    await expect(validateV5ReplayCorpus(corpus, changed, WITNESS)).rejects.toThrow(/detector thresholds|rule hash|configuration/i);
  });

  it("[framework:V5] requires the separately pinned external Ed25519 witness key", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(validateV5ReplayCorpus(corpus, candidate, {
      publicKeyPem: other,
      expectedKeySha256: v5WitnessKeyFingerprint(other),
    })).rejects.toThrow(/witness key does not match|signature verification/i);
  });

  it("[framework:V5] rejects protected field roots reached through a symlinked parent", async () => {
    const alias = path.join(root, "field-parent-alias");
    await symlink(root, alias);
    await expect(runV5HeldOutReplay({
      corpusRoot: corpus,
      protectedFieldRoot: path.join(alias, "protected-field"),
      candidate,
      witness: WITNESS,
      runId: "symlinked-field-root",
    })).rejects.toThrow(/symlinked path components/);
  });

  it("[framework:V5] keeps a never-observed event separate from detector misses and unknown data", async () => {
    const unobservedCorpus = path.join(root, "unobserved-corpus");
    await cp(corpus, unobservedCorpus, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(unobservedCorpus, "corpus-manifest.json"), "utf8")) as V5ReplayCorpusManifest;
    const alertSession = manifest.sessions.find((entry) => manifest.criteria.find((criterion) => criterion.criterionId === entry.criterionId)?.expectedOutcome === "alert")!;
    const descriptor = JSON.parse(await readFile(path.join(unobservedCorpus, ...alertSession.descriptorPath.split("/")), "utf8")) as V5SessionDescriptor;
    const records = (await readFile(path.join(unobservedCorpus, ...descriptor.observations.indexPath.split("/")), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as V5ObservationRecord);
    for (const [index, record] of records.entries()) if (record.outcome === "valid") {
      record.firstMonotonicMs = 6_000 + index * 1_500;
      record.lastMonotonicMs = record.firstMonotonicMs + 1_000;
      record.observedAt = new Date(Date.parse("2026-01-10T00:00:00.000Z") + record.lastMonotonicMs).toISOString();
    }
    await writeFile(path.join(unobservedCorpus, ...descriptor.observations.indexPath.split("/")), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await writeFile(path.join(unobservedCorpus, ...descriptor.observations.fftPath.split("/")), new Uint8Array(descriptor.grid.inputBinCount * descriptor.observations.validRecordCount).fill(30));
    await resealCorpus(unobservedCorpus);
    const report = await runV5HeldOutReplay({ corpusRoot: unobservedCorpus, protectedFieldRoot: field, candidate, witness: WITNESS, runId: "unobserved-fixture" });
    expect(report.counts).toMatchObject({ missed: 0, unknown: 240, unobserved: 1 });
    expect(report.sessions.find((session) => session.sessionId === alertSession.sessionId)?.verdict).toBe("unobserved");
    expect(report.result.gateDecision).toBe("failed");
    expect(report.criteria.find((criterion) => criterion.criterionId === alertSession.criterionId)?.failureReasons).toContain("minimum-evaluable-independent-sessions-not-met");
  }, 120_000);

  it("[framework:V5] rejects a fully resealed corpus that marks simulated/test input as real field acquisition", async () => {
    const mixedCorpus = path.join(root, "mixed-corpus");
    await cp(corpus, mixedCorpus, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(mixedCorpus, "corpus-manifest.json"), "utf8")) as V5ReplayCorpusManifest;
    const descriptorPath = manifest.sessions[0].descriptorPath;
    const descriptor = JSON.parse(await readFile(path.join(mixedCorpus, ...descriptorPath.split("/")), "utf8")) as V5SessionDescriptor;
    const unsafe = descriptor as unknown as { source: { realReceiver: boolean; synthetic: boolean; acquisitionDataDomain: string } };
    unsafe.source.realReceiver = false;
    unsafe.source.synthetic = true;
    unsafe.source.acquisitionDataDomain = "test";
    await writeFile(path.join(mixedCorpus, ...descriptorPath.split("/")), `${JSON.stringify(unsafe, null, 2)}\n`);
    await resealCorpus(mixedCorpus, descriptorPath);
    await expect(runV5HeldOutReplay({ corpusRoot: mixedCorpus, protectedFieldRoot: field, candidate, witness: WITNESS, runId: "mixed-fixture" })).rejects.toThrow(/not an isolated real normalized-uint8 field acquisition/);
  }, 120_000);

  it("[framework:V5] rejects byte tampering and symbolic links instead of following them", async () => {
    const tampered = path.join(root, "tampered-corpus");
    await cp(corpus, tampered, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(tampered, "corpus-manifest.json"), "utf8")) as V5ReplayCorpusManifest;
    const fftPath = manifest.files.find((entry) => entry.path.endsWith("/fft.uint8") && entry.bytes > 0)!.path;
    const bytes = await readFile(path.join(tampered, ...fftPath.split("/")));
    bytes[0] ^= 0xff;
    await writeFile(path.join(tampered, ...fftPath.split("/")), bytes);
    await expect(validateV5ReplayCorpus(tampered, candidate, WITNESS)).rejects.toThrow(/hash\/size mismatch/);

    const linked = path.join(root, "linked-corpus");
    await cp(corpus, linked, { recursive: true });
    const truthPath = manifest.files.find((entry) => entry.path.endsWith("/truth.json"))!.path;
    const absoluteTruth = path.join(linked, ...truthPath.split("/"));
    await rm(absoluteTruth);
    await symlink(path.join(corpus, ...truthPath.split("/")), absoluteTruth);
    await expect(validateV5ReplayCorpus(linked, candidate, WITNESS)).rejects.toThrow(/symbolic link/);
  }, 120_000);
});
