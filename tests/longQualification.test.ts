import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATE_POLICY,
  MAX_SAMPLES,
  QualificationRunStore,
  REQUIRED_V7_FAULT_CASES,
  SAMPLE_INTERVAL_MS,
  analyzeLongQualification,
  assertV7PhysicalSnapshot,
  buildLongQualificationFailure,
  identityDigest,
  signedRecordPayload,
  validateQualificationBinding,
  validateV7FaultRecoveryMatrix,
  witnessPublicKeyDigest,
} from "../scripts/lib/long-qualification.mjs";

const HASH = "a".repeat(64);
const TARGETS = [
  { targetId: "gnss-l1-e1-b1c-sbas", objectiveMs: 2_000 },
  { targetId: "gnss-gps-l2c", objectiveMs: 6_000 },
  { targetId: "gnss-l5-e5a-b2a", objectiveMs: 6_000 },
  { targetId: "gnss-glonass-g1", objectiveMs: 6_000 },
];
const witnessKeys = generateKeyPairSync("ed25519");
const witnessPublicKeyPem = witnessKeys.publicKey.export({ format: "pem", type: "spki" }).toString();

function signRecord<T extends Record<string, any>>(record: T): T & { witness: Record<string, unknown> } {
  const signedAt = new Date(Date.parse(record.completedAt) + 60_000).toISOString();
  const withWitness = {
    ...record,
    witness: {
      id: "site-verifier-1",
      algorithm: "Ed25519",
      signedAt,
      publicKeySha256: witnessPublicKeyDigest(witnessPublicKeyPem),
      signatureBase64: "pending",
    },
  };
  withWitness.witness.signatureBase64 = sign(null, Buffer.from(signedRecordPayload(withWitness)), witnessKeys.privateKey).toString("base64");
  return withWitness;
}

function binding() {
  return {
    schemaVersion: 1,
    kind: "rf-monitor-site-qualification-binding",
    candidateId: "candidate-1",
    releaseBuildId: "release-1",
    serverBuildId: "release-1",
    clientBuildId: "release-1",
    sourceDigest: HASH,
    packageDigest: "b".repeat(64),
    dependencyLockDigest: "c".repeat(64),
    configurationHash: "d".repeat(64),
    catalogVersion: "catalog-v3",
    detectorRuleSetId: "detector-v1",
    siteBindingHash: "e".repeat(64),
    receiverModel: "RSPdx",
    // The server derives this from the supported model and hardware serial.
    receiverIdentityHash: "f".repeat(64),
    expectedSampleRateHz: 10_000_000,
    installedChainFingerprintSha256: "9".repeat(64),
    qualificationWitnessId: "site-verifier-1",
    qualificationWitnessPublicKeySha256: witnessPublicKeyDigest(witnessPublicKeyPem),
    tier1Targets: TARGETS.map((target, index) => ({ ...target, baselineFingerprintId: String(index + 1).repeat(64) })),
  } as const;
}

function targetCounters(epoch: string, final = false) {
  return TARGETS.map((target) => ({
    commissioningEpochId: epoch,
    ...target,
    validCompletions: final ? 1_001 : 0,
    validRevisits: final ? 1_000 : 0,
    objectiveMetRevisits: final ? 999 : 0,
    objectiveMissedRevisits: final ? 1 : 0,
    objectiveBreaches: final ? 2 : 0,
    unknownVisits: 0,
    missesByCause: final ? { "revisit-objective-missed": 2 } : {},
    unknownsByCause: {},
    revisitHistogram: { boundsMs: [2_000, 6_000, 10_000], counts: final ? (target.objectiveMs === 2_000 ? [1_000, 0, 0] : [0, 1_000, 0]) : [0, 0, 0], overflow: 0, samples: final ? 1_000 : 0 },
    unobservedGapHistogram: { boundsMs: [2_000, 6_000, 10_000], counts: final ? [1_000, 0, 0] : [0, 0, 0], overflow: 0, samples: final ? 1_000 : 0 },
    revisitMs: { samples: final ? 1_000 : 0, last: target.objectiveMs, p50: target.objectiveMs - 100, p95: target.objectiveMs, p99: target.objectiveMs, maximum: target.objectiveMs + 1 },
    unobservedGapMs: { samples: final ? 1_000 : 0, last: 900, p50: 850, p95: 900, p99: 950, maximum: 1_000 },
  }));
}

function baselineRows(lifecycle = "reviewable") {
  return TARGETS.map((target, index) => ({
    targetId: target.targetId,
    lifecycle,
    fingerprintId: String(index + 1).repeat(64),
    representativeHours: 24,
    validCoverageRatio: 1,
  }));
}

function fixtureSamples(hours: number) {
  const start = Date.parse("2026-08-24T00:00:00.000Z");
  const count = hours * 3_600_000 / SAMPLE_INTERVAL_MS + 1;
  const epoch = "commissioning-epoch-1";
  const zeroTargets = targetCounters(epoch, false);
  const finalTargets = targetCounters(epoch, true);
  const common = {
    schemaVersion: 1,
    collectorBootId: "collector-boot-1",
    serviceBootId: "service-boot-1",
    serviceStartedAt: "2026-08-23T23:50:00.000Z",
    identityDigest: identityDigest(binding()),
    commissioningEpochId: epoch,
    configurationEpoch: 1,
    tuneEpoch: 10,
    currentHealth: { state: "normal", ready: true, monitoringReady: true, evidenceReady: true },
    commissioning: { state: "qualifying", ready: true, receiverReady: true, sampleRateReady: true, simulation: false, dataDomain: "field", faults: [] },
    receiver: { availability: "available", usb: "present", transport: "connected", frames: "live", sampleRateMatches: true, reconnectAttempts: 0, recoveryState: "healthy" },
    continuity: { receivedFrames: 100, analyzedObservations: 100, invalidOrStaleFrames: 0, unknownVisits: 0, missedObjectives: 0, evidenceFramesRecorded: 100, evidenceFramesLost: 0, browserFramesDropped: 0 },
    attribution: { acceptedInvariantViolations: 0, rejectedEpochFrames: 0 },
    clock: { opsGeneratedAt: "2026-08-24T00:00:00.000Z", opsRecordSha256: HASH, synchronized: true, serviceRestarts: 0 },
    software: { rssBytes: 256 * 1024 * 1024, heapUsedBytes: 128 * 1024 * 1024, externalBytes: 32 * 1024 * 1024, eventLoopP99Ms: 20, hostCpuPercent: 25, hostCpu60Percent: 25, rfMonitorCpuPercent: 20, rfMonitorCpu60Percent: 20 },
    network: { liveBytesPerSecond10s: 64 * 1024, liveBytesPerSecond60s: 64 * 1024, applicationBytesPerSecond10s: 64 * 1024, applicationBytesPerSecond60s: 64 * 1024, dashboards: 8, queuedBytes: 0, applicationDrops: 0, interfaces: [{ id: "eth0", state: "up", receiveErrors: 0, transmitErrors: 0, receiveDrops: 0, transmitDrops: 0 }], rejectedClients: 1 },
    evidence: { healthy: true, writerQueueItems: 0, writerQueueBytes: 0, writerOldestAgeMs: 0, diskFreeBytes: 100 * 1024 ** 3, diskReserveBytes: 5 * 1024 ** 3, diskPressure: false, exportsActive: 0, exportsQueued: 0, exportDownloadActive: false },
    recovery: { receiver: "verified-recovery", application: "verified-recovery" },
  };
  return Array.from({ length: count }, (_, index) => {
    const atMs = start + index * SAMPLE_INTERVAL_MS;
    const at = new Date(atMs).toISOString();
    const last = index === count - 1;
    const exportSample = atMs === Date.parse("2026-08-24T23:52:00.000Z") || (hours < 24 && index === count - 2);
    return {
      ...common,
      sequence: index + 1,
      collectorMonotonicMs: index * SAMPLE_INTERVAL_MS,
      capturedAt: at,
      serverGeneratedAt: at,
      clock: { ...common.clock, opsGeneratedAt: at },
      evidence: { ...common.evidence, exportDownloadActive: exportSample },
      software: { ...common.software, ...(exportSample ? { eventLoopP99Ms: 40 } : {}) },
      network: { ...common.network, interfaces: common.network.interfaces.map((entry) => ({ ...entry })) },
      schedule: { profile: "fast-gnss", optionalWorkAdmitted: false, targets: last ? finalTargets : zeroTargets, baselines: baselineRows() },
    };
  });
}

function prerequisites() {
  const gateArtifacts = Array.from({ length: 7 }, (_, index) => String(index + 1).repeat(64));
  return signRecord({
    schemaVersion: 1,
    kind: "rf-monitor-v7-prerequisites",
    identityDigest: identityDigest(binding()),
    installedChainFingerprintSha256: binding().installedChainFingerprintSha256,
    completedAt: "2026-08-23T17:50:00.000Z",
    outcome: "PASS",
    gates: gateArtifacts.map((artifactSha256, index) => ({ gate: `V${index}`, outcome: "PASS", artifactSha256 })),
    claims: {
      v2AcceptedAttributionInvariantViolations: 0,
      v5RealReceiverDerivedFftOnly: true,
      v5SyntheticOrTestInputsAccepted: 0,
      v6PhysicalInstalledChain: true,
      v6InstalledChainFingerprintSha256: binding().installedChainFingerprintSha256,
    },
    evidenceFiles: gateArtifacts.map((sha256, index) => ({ path: `v${index}-qualification.json`, sha256 })),
  });
}

function faultMatrix() {
  return signRecord({
    schemaVersion: 1,
    kind: "rf-monitor-v7-fault-recovery-matrix",
    identityDigest: identityDigest(binding()),
    faultPhaseId: "fault-phase-1",
    phaseStartedAt: "2026-08-23T18:00:00.000Z",
    phaseEndedAt: "2026-08-23T22:45:00.000Z",
    completedAt: "2026-08-23T22:50:00.000Z",
    outcome: "PASS",
    acceptance: { stalledReceiverDetectionMaxMs: 8_000, recoveryStartMaxMs: 20_000, receiverRestorationMaxMs: 90_000, terminalFailuresVisible: true, restartLoops: 0, evidenceFramesLost: 0 },
    cases: REQUIRED_V7_FAULT_CASES.map((id) => ({ id, outcome: "PASS", executedAt: "2026-08-23T20:00:00.000Z", evidenceSha256: HASH })),
    evidenceFiles: [{ path: "fault-evidence.json", sha256: HASH }],
  });
}

function backupRestore() {
  return signRecord({
    schemaVersion: 1,
    kind: "rf-monitor-v7-backup-restore",
    identityDigest: identityDigest(binding()),
    completedAt: "2026-08-23T22:30:00.000Z",
    faultPhaseId: "fault-phase-1",
    outcome: "PASS",
    backup: { outcome: "PASS", performedAt: "2026-08-23T20:30:00.000Z", packageSha256: "4".repeat(64), verificationSha256: "5".repeat(64), offHost: true, independentlyVerified: true, recoveryPointAgeSeconds: 600 },
    restore: { outcome: "PASS", performedAt: "2026-08-23T22:00:00.000Z", verificationSha256: "6".repeat(64), recoveryTimeSeconds: 1_800, fieldTestDomainsSeparated: true, evidenceVerified: true, independentlyVerified: true },
    evidenceFiles: [
      { path: "backup-package.bin", sha256: "4".repeat(64) },
      { path: "backup-verification.json", sha256: "5".repeat(64) },
      { path: "restore-verification.json", sha256: "6".repeat(64) },
    ],
  });
}

function switchCounters(capturedAfterAt = "2026-08-25T00:01:00.000Z") {
  return signRecord({
    schemaVersion: 1,
    kind: "rf-monitor-v7-switch-counters",
    identityDigest: identityDigest(binding()),
    capturedBeforeAt: "2026-08-23T23:59:00.000Z",
    capturedAfterAt,
    completedAt: new Date(Date.parse(capturedAfterAt) + 60_000).toISOString(),
    outcome: "PASS",
    evidenceSha256: HASH,
    ports: [{ portId: "host-port-1", egressDropsDelta: 0, egressDiscardsDelta: 0, pauseFramesDelta: 0, inputErrorsDelta: 0, inputDiscardsDelta: 0, portResetsDelta: 0, linkSpeedMbps: 1_000, fullDuplex: true }],
    evidenceFiles: [{ path: "switch-counters.txt", sha256: HASH }],
  });
}

function loadExercise(startedAt = "2026-08-24T23:50:00.000Z", endedAt = "2026-08-24T23:55:00.000Z") {
  return signRecord({
    schemaVersion: 1,
    kind: "rf-monitor-v7-load-exercise",
    identityDigest: identityDigest(binding()),
    completedAt: new Date(Date.parse(endedAt) + 60_000).toISOString(),
    startedAt,
    endedAt,
    outcome: "PASS",
    engineerDashboards: 8,
    ninthDashboardRejected: true,
    alertEvidenceRateHz: 4,
    exportDownloadBytesPerSecond: 5 * 1024 * 1024,
    liveTrafficBytesPerSecond: 256 * 1024,
    liveBurstBytes: 512 * 1024,
    applicationEgressBytesPerSecond: 5.5 * 1024 * 1024,
    visibleDiagnosticsBytesPerSecondPerClient: 8 * 1024,
    maxPerClientQueuedBytes: 64 * 1024,
    maxControlStateBytes: 64 * 1024,
    maxWriterQueueItems: 8,
    maxWriterQueueBytes: 256 * 1024,
    maxWriterAgeMs: 200,
    maxSpectrumRingSeconds: 60,
    maxSpectrumRingRateHz: 4,
    maxWaterfallRowsPerTarget: 32,
    maxStoredSpectrumBins: 2_048,
    maxRawChunkBytes: 128 * 1024 * 1024,
    maxSessionBytes: 2 * 1024 * 1024 * 1024,
    maxSessionDurationMs: 24 * 60 * 60_000,
    maxIncidentExportPartBytes: 256 * 1024 * 1024,
    alertEvidenceLoss: 0,
    clearEvidenceFramesRecorded: 10_000,
    clearEvidenceFramesLost: 0,
    evidenceLoss: 0,
    evidenceSha256: HASH,
    evidenceFiles: [{ path: "load-exercise.json", sha256: HASH }],
  });
}

function v7External(options: { short?: boolean } = {}) {
  return {
    witnessPublicKeyPem,
    prerequisites: prerequisites(),
    faultMatrix: faultMatrix(),
    backupRestore: backupRestore(),
    switchCounters: switchCounters(options.short ? "2026-08-24T23:01:00.000Z" : undefined),
    loadExercise: options.short ? loadExercise("2026-08-24T22:50:00.000Z", "2026-08-24T22:55:00.000Z") : loadExercise(),
  };
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("V7 bounded installed-chain qualification", () => {
  it("binds exactly one supported receiver model and model+serial identity digest", () => {
    expect(validateQualificationBinding(binding())).toMatchObject({ receiverModel: "RSPdx", receiverIdentityHash: "f".repeat(64), expectedSampleRateHz: 10_000_000 });
    expect(() => validateQualificationBinding({ ...binding(), receiverModel: "RSPdx clone" })).toThrow("binding-receiver-model-invalid");
    expect(() => validateQualificationBinding({ ...binding(), receiverIdentityHash: "unknown" })).toThrow("binding-receiver-hash-invalid");
    expect(() => validateQualificationBinding({ ...binding(), tier1Targets: TARGETS.slice(0, 3) })).toThrow("requires-four");
  });

  it("structurally refuses simulation, non-field domains, and every non-live receiver-path state", () => {
    const sample = fixtureSamples(0)[0];
    expect(assertV7PhysicalSnapshot(sample)).toBe(sample);
    const mutations: Array<[(copy: any) => void, string]> = [
      [(copy) => { copy.commissioning.simulation = true; }, "v7-simulation-refused"],
      [(copy) => { copy.commissioning.dataDomain = "test"; }, "v7-field-domain-required"],
      [(copy) => { copy.commissioning.receiverReady = false; }, "v7-physical-receiver-not-ready"],
      [(copy) => { copy.commissioning.sampleRateReady = false; }, "v7-sample-rate-not-confirmed"],
      [(copy) => { copy.receiver.availability = "unavailable"; }, "v7-receiver-unavailable"],
      [(copy) => { copy.receiver.usb = "not-present"; }, "v7-usb-not-present"],
      [(copy) => { copy.receiver.transport = "disconnected"; }, "v7-sdrconnect-not-connected"],
      [(copy) => { copy.receiver.frames = "stalled"; }, "v7-live-rf-frames-required"],
      [(copy) => { copy.receiver.sampleRateMatches = false; }, "v7-sample-rate-mismatch"],
    ];
    for (const [mutate, error] of mutations) {
      const copy = structuredClone(sample);
      mutate(copy);
      expect(() => assertV7PhysicalSnapshot(copy)).toThrow(error);
    }
  });

  it("passes only the analyzer fixture contract with every bounded V7 proof present", () => {
    const result = analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(24), external: v7External() });
    expect(result).toMatchObject({ gate: "V7", result: "PASS", elapsedMs: GATE_POLICY.v7.requiredElapsedMs });
    expect(result.resourceMetrics).toMatchObject({ rssP99Bytes: 256 * 1024 * 1024, heapP99Bytes: 128 * 1024 * 1024, applicationNetworkDrops: 0 });
    expect(result.externalEvidence).toEqual(expect.objectContaining({ faultRecoveryMatrixSha256: expect.stringMatching(/^[a-f0-9]{64}$/), loadExerciseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(result.targets.every((target: { validRevisits: number; onTimeRatio: number }) => target.validRevisits === 1_000 && target.onTimeRatio === 0.999)).toBe(true);
  });

  it("accepts only the bounded sampling tolerance and rejects any observation beyond 24 hours", () => {
    const complete = fixtureSamples(24);
    const withinTolerance = complete.slice(0, -3);
    withinTolerance.at(-1)!.schedule = structuredClone(complete.at(-1)!.schedule);
    expect(Date.parse(withinTolerance.at(-1)!.serverGeneratedAt) - Date.parse(withinTolerance[0].serverGeneratedAt)).toBe(GATE_POLICY.v7.minimumAcceptedElapsedMs);
    expect(analyzeLongQualification({ gate: "v7", binding: binding(), samples: withinTolerance, external: v7External() }).result).toBe("PASS");

    const overMaximum = fixtureSamples(24);
    const extra = structuredClone(overMaximum.at(-1)!);
    extra.sequence += 1;
    extra.collectorMonotonicMs += SAMPLE_INTERVAL_MS;
    extra.serverGeneratedAt = new Date(Date.parse(extra.serverGeneratedAt) + SAMPLE_INTERVAL_MS).toISOString();
    extra.capturedAt = extra.serverGeneratedAt;
    extra.clock.opsGeneratedAt = extra.serverGeneratedAt;
    overMaximum.push(extra);
    const result = analyzeLongQualification({ gate: "v7", binding: binding(), samples: overMaximum, external: v7External() });
    expect(result.result).toBe("FAIL");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "qualification-maximum-elapsed-exceeded", limit: 24 * 60 * 60_000 }));
  });

  it("does not convert an incomplete 23-hour run into a pass", () => {
    expect(analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(23), external: v7External({ short: true }) }).result).toBe("NOT_READY");
  });

  it("requires the complete witnessed V7 fault/recovery matrix", () => {
    expect(validateV7FaultRecoveryMatrix(faultMatrix(), binding(), witnessPublicKeyPem).cases).toHaveLength(REQUIRED_V7_FAULT_CASES.length);
    const complete = faultMatrix();
    const { witness: _witness, ...unsigned } = complete;
    const incomplete = signRecord({ ...unsigned, cases: complete.cases.slice(0, -1) });
    expect(() => validateV7FaultRecoveryMatrix(incomplete, binding(), witnessPublicKeyPem)).toThrow("fault-matrix-cases-required");
  });

  it("fails closed on synthetic V5 prerequisites, switch loss, and resource pressure", () => {
    const syntheticExternal = v7External();
    const { witness: _prerequisiteWitness, ...unsignedPrerequisites } = syntheticExternal.prerequisites;
    syntheticExternal.prerequisites = signRecord({ ...unsignedPrerequisites, claims: { ...unsignedPrerequisites.claims, v5RealReceiverDerivedFftOnly: false, v5SyntheticOrTestInputsAccepted: 1 } });
    expect(() => analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(24), external: syntheticExternal })).toThrow("v7-prerequisite-v5-real-receiver-fft-missing");

    const switchExternal = v7External();
    const { witness: _switchWitness, ...unsignedSwitch } = switchExternal.switchCounters;
    switchExternal.switchCounters = signRecord({ ...unsignedSwitch, ports: [{ ...unsignedSwitch.ports[0], egressDropsDelta: 1 }] });
    expect(() => analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(24), external: switchExternal })).toThrow("switch-egressDropsDelta-nonzero");

    const pressured = fixtureSamples(24);
    pressured.at(-1)!.software.rssBytes = 600 * 1024 * 1024;
    pressured.at(-1)!.network.interfaces[0].receiveDrops = 1;
    const result = analyzeLongQualification({ gate: "v7", binding: binding(), samples: pressured, external: v7External() });
    expect(result.result).toBe("FAIL");
    expect(result.findings.map((finding: { code: string }) => finding.code)).toEqual(expect.arrayContaining(["rss-maximum-limit", "network-counter-increase"]));
  });

  it("rejects an unverified backup and an out-of-bound load record", () => {
    const backupExternal = v7External();
    const { witness: _backupWitness, ...unsignedBackup } = backupExternal.backupRestore;
    backupExternal.backupRestore = signRecord({ ...unsignedBackup, backup: { ...unsignedBackup.backup, offHost: false } });
    expect(() => analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(24), external: backupExternal })).toThrow("v7-off-host-backup-not-proven");

    const loadExternal = v7External();
    const { witness: _loadWitness, ...unsignedLoad } = loadExternal.loadExercise;
    loadExternal.loadExercise = signRecord({ ...unsignedLoad, maxWriterQueueItems: 64 });
    expect(() => analyzeLongQualification({ gate: "v7", binding: binding(), samples: fixtureSamples(24), external: loadExternal })).toThrow("v7-load-writer-items-limit");
  });

  it("detects boot, counter, and target discontinuities", () => {
    const bootChanged = fixtureSamples(24);
    bootChanged.at(-1)!.serviceBootId = "service-boot-2";
    expect(analyzeLongQualification({ gate: "v7", binding: binding(), samples: bootChanged, external: v7External() }).findings.map((item: { code: string }) => item.code)).toContain("service-boot-changed");

    const counterReset = fixtureSamples(24);
    counterReset[Math.floor(counterReset.length / 2)].schedule.targets = targetCounters("commissioning-epoch-1", true);
    expect(analyzeLongQualification({ gate: "v7", binding: binding(), samples: counterReset, external: v7External() }).findings.some((item: { code: string }) => item.code.includes("counter-reset"))).toBe(true);

    const missingTarget = fixtureSamples(24);
    missingTarget.at(-1)!.schedule.targets = missingTarget.at(-1)!.schedule.targets.slice(0, 3);
    expect(analyzeLongQualification({ gate: "v7", binding: binding(), samples: missingTarget, external: v7External() }).findings.map((item: { code: string }) => item.code)).toContain("target-timing-missing");
  });

  it("writes no-replace chunks and refuses a symlinked run path", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-long-qualification-"));
    roots.push(parent);
    const runDirectory = path.join(parent, "v7-run");
    const store = new QualificationRunStore(runDirectory);
    await store.initialize({ gate: "v7", binding: binding() });
    const appender = await store.createAppender("samples");
    await appender.append(fixtureSamples(0)[0]);
    await appender.close();
    expect((await store.readSamples()).samples).toHaveLength(1);

    const partialSample = path.join(runDirectory, "samples", "samples-crash.jsonl.partial");
    const partialSampleHandle = await open(partialSample, "wx", 0o600);
    await partialSampleHandle.write('{"schemaVersion":1');
    await partialSampleHandle.close();
    const partialEvent = path.join(runDirectory, "events", "events-crash.jsonl.partial");
    const partialEventHandle = await open(partialEvent, "wx", 0o600);
    await partialEventHandle.write(`${JSON.stringify({ schemaVersion: 1, type: "before-crash", severity: "notice", at: "2026-08-24T00:00:00.000Z" })}\n`);
    await partialEventHandle.close();
    const recoveredSamples = await store.readSamples();
    expect(recoveredSamples.recoveryEvents.every((event: { severity: string }) => event.severity === "blocking")).toBe(true);
    const failure = (buildLongQualificationFailure as any)({ gate: "v7", binding: binding(), samples: recoveredSamples.samples, events: recoveredSamples.recoveryEvents, error: new Error("partial-chunk") });
    const resultPath = await store.finalize(failure);
    const persisted = JSON.parse(await readFile(resultPath, "utf8"));
    expect(persisted.result).toBe("FAIL");
    expect(persisted.sampleFiles.some((entry: { path: string }) => entry.path.endsWith(".partial"))).toBe(true);

    const real = path.join(parent, "real");
    await mkdir(real);
    const linked = path.join(parent, "linked");
    await symlink(real, linked);
    await expect(new QualificationRunStore(linked).load()).rejects.toThrow("qualification-symlink-refused");
  });

  it("caps offline analysis to the 24-hour sample envelope", () => {
    const one = fixtureSamples(0)[0];
    expect(() => analyzeLongQualification({ gate: "v7", binding: binding(), samples: Array(MAX_SAMPLES + 1).fill(one), external: v7External() })).toThrow("qualification-samples-invalid");
  });

  it("refuses removed V8 runtime analysis", () => {
    expect(() => analyzeLongQualification({ gate: "v8", binding: binding(), samples: fixtureSamples(24), external: v7External() })).toThrow("qualification-gate-invalid");
  });
});
