import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const SAMPLE_INTERVAL_MS = 5_000;
export const MAX_SAMPLE_GAP_MS = 15_000;
export const CHUNK_MAX_BYTES = 16 * 1024 * 1024;
export const RECORD_MAX_BYTES = 32 * 1024;
export const EVENT_MAX_BYTES = 8 * 1024;
export const MAX_EVENT_RECORDS = 4_096;
// A 24-hour run at the fixed five-second cadence is 17,281 inclusive
// samples. The margin permits clock alignment and diagnostic records without
// allowing a corrupt run to make final analysis retain an unbounded graph.
export const MAX_SAMPLES = 20_000;
export const MAX_TOTAL_SAMPLE_BYTES = 128 * 1024 * 1024;
export const RSS_P99_LIMIT_BYTES = 384 * 1024 * 1024;
export const RSS_MAX_LIMIT_BYTES = 448 * 1024 * 1024;
export const HEAP_P99_LIMIT_BYTES = 256 * 1024 * 1024;
export const RSS_SLOPE_LIMIT_BYTES_PER_HOUR = 1024 * 1024;
export const LIVE_BANDWIDTH_LIMIT_BYTES_PER_SECOND = 1024 * 1024;
export const APPLICATION_EGRESS_LIMIT_BYTES_PER_SECOND = 6 * 1024 * 1024;
export const WRITER_QUEUE_ITEMS_LIMIT = 64;
export const WRITER_QUEUE_BYTES_LIMIT = 2 * 1024 * 1024;
export const WRITER_AGE_LIMIT_MS = 2_000;
export const CLIENT_QUEUE_TOTAL_LIMIT_BYTES = 8 * 256 * 1024;

export const GATE_POLICY = Object.freeze({
  // V7 is the final development gate. The one-sample tolerance lets a
  // five-second sampler finish before the hard 24-hour wall-clock ceiling; it
  // is not an extension of the observation objective.
  v7: Object.freeze({
    gate: "V7",
    requiredElapsedMs: 24 * 60 * 60_000,
    minimumAcceptedElapsedMs: 24 * 60 * 60_000 - MAX_SAMPLE_GAP_MS,
    maximumElapsedMs: 24 * 60 * 60_000,
  }),
});

export const REQUIRED_V7_FAULT_CASES = Object.freeze([
  "usb-removal",
  "sdrconnect-stop",
  "sdrconnect-crash",
  "sdrconnect-hang",
  "sdrconnect-initialization-failure",
  "sdrconnect-start-limit-lockout",
  "rf-monitor-crash",
  "rf-monitor-event-loop-hang",
  "tune-timeout",
  "tune-delayed-confirmation",
  "tune-mismatched-confirmation",
  "stale-frame",
  "rf-rate-gain-configuration-change",
  "browser-network-interruption",
  "slow-client",
  "eight-live-clients",
  "ninth-live-client-rejected",
  "disk-reserve",
  "disk-full",
  "filesystem-read-only",
  "evidence-mount-lost",
  "torn-write",
  "sudden-power-loss",
  "wall-clock-jump",
  "ntp-loss",
  "corrupt-configuration",
  "corrupt-baseline",
  "corrupt-index",
  "corrupt-evidence-tail",
  "cpu-pressure",
  "rss-pressure",
  "heap-pressure",
  "external-buffer-pressure",
  "event-loop-pressure",
  "writer-queue-pressure",
  "export-pressure",
  "nic-switch-errors-drops-pause",
  "network-link-reset",
  "upgrade-failure",
  "rollback",
  "backup-failure",
  "bare-host-restore",
]);

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const KNOWN_CAUSES = new Set([
  "tune-timeout",
  "insufficient-frames",
  "receiver-unhealthy",
  "configuration-changed",
  "tune-mismatch",
  "bin-grid-changed",
  "revisit-objective-missed",
  "invalid-observation",
  "other",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function string(value, label, pattern) {
  assertion(typeof value === "string" && value.length > 0, `${label}-required`);
  if (pattern) assertion(pattern.test(value), `${label}-invalid`);
  return value;
}

function finite(value, label, minimum = 0) {
  assertion(typeof value === "number" && Number.isFinite(value) && value >= minimum, `${label}-invalid`);
  return value;
}

function integer(value, label, minimum = 0) {
  assertion(Number.isSafeInteger(value) && value >= minimum, `${label}-invalid`);
  return value;
}

function timestamp(value, label) {
  const parsed = Date.parse(string(value, label));
  assertion(Number.isFinite(parsed), `${label}-invalid`);
  return new Date(parsed).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function identityDigest(binding) {
  return sha256(canonicalJson(validateQualificationBinding(binding)));
}

export function witnessPublicKeyDigest(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  assertion(key.asymmetricKeyType === "ed25519", "qualification-witness-key-must-be-ed25519");
  return sha256(key.export({ format: "der", type: "spki" }));
}

export function signedRecordPayload(record) {
  assertion(object(record) && object(record.witness), "qualification-signed-record-required");
  const { signatureBase64: _signature, ...witness } = record.witness;
  return canonicalJson({ ...record, witness });
}

export function validateQualificationBinding(input) {
  assertion(object(input), "binding-object-required");
  assertion(input.schemaVersion === 1, "binding-schema-version-invalid");
  assertion(input.kind === "rf-monitor-site-qualification-binding", "binding-kind-invalid");
  const tier1Targets = input.tier1Targets;
  assertion(Array.isArray(tier1Targets) && tier1Targets.length === 4, "binding-tier1-targets-requires-four");
  const targets = tier1Targets.map((target, index) => {
    assertion(object(target), `binding-target-${index}-invalid`);
    return {
      targetId: string(target.targetId, `binding-target-${index}-id`, SAFE_ID),
      objectiveMs: integer(target.objectiveMs, `binding-target-${index}-objective`, 1),
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId));
  assertion(new Set(targets.map((target) => target.targetId)).size === targets.length, "binding-target-duplicate");
  assertion(targets.filter((target) => target.objectiveMs === 2_000).length === 1, "binding-tier1-requires-one-2s-target");
  assertion(targets.filter((target) => target.objectiveMs === 6_000).length === 3, "binding-tier1-requires-three-6s-targets");
  assertion(input.expectedSampleRateHz === 10_000_000, "binding-production-sample-rate-required");
  return {
    schemaVersion: 1,
    kind: "rf-monitor-site-qualification-binding",
    candidateId: string(input.candidateId, "binding-candidate-id", SAFE_ID),
    releaseBuildId: string(input.releaseBuildId, "binding-release-build-id", SAFE_ID),
    serverBuildId: string(input.serverBuildId, "binding-server-build-id", SAFE_ID),
    clientBuildId: string(input.clientBuildId, "binding-client-build-id", SAFE_ID),
    sourceDigest: string(input.sourceDigest, "binding-source-digest", HASH),
    packageDigest: string(input.packageDigest, "binding-package-digest", HASH),
    dependencyLockDigest: string(input.dependencyLockDigest, "binding-lock-digest", HASH),
    configurationHash: string(input.configurationHash, "binding-configuration-hash", HASH),
    catalogVersion: string(input.catalogVersion, "binding-catalog-version", SAFE_ID),
    detectorRuleSetId: string(input.detectorRuleSetId, "binding-detector-rules", SAFE_ID),
    siteBindingHash: string(input.siteBindingHash, "binding-site-hash", HASH),
    receiverModel: ["RSPdx", "RSPdx R2"].includes(input.receiverModel) ? input.receiverModel : (() => { throw new Error("binding-receiver-model-invalid"); })(),
    receiverIdentityHash: string(input.receiverIdentityHash, "binding-receiver-hash", HASH),
    installedChainFingerprintSha256: string(input.installedChainFingerprintSha256, "binding-installed-chain-hash", HASH),
    qualificationWitnessId: string(input.qualificationWitnessId, "binding-witness-id", SAFE_ID),
    qualificationWitnessPublicKeySha256: string(input.qualificationWitnessPublicKeySha256, "binding-witness-key-hash", HASH),
    expectedSampleRateHz: integer(input.expectedSampleRateHz, "binding-sample-rate", 1),
    tier1Targets: targets.map((target) => ({
      ...target,
      baselineFingerprintId: string(tier1Targets.find((candidate) => candidate.targetId === target.targetId)?.baselineFingerprintId, `binding-target-${target.targetId}-baseline-fingerprint`, HASH),
    })),
  };
}

function counterTotal(input, label) {
  assertion(object(input), `${label}-counter-required`);
  return integer(input.total, `${label}-total`);
}

function distribution(input, label) {
  assertion(object(input), `${label}-distribution-required`);
  const result = { samples: integer(input.samples, `${label}-samples`) };
  for (const key of ["last", "p50", "p95", "p99", "maximum"]) {
    if (input[key] !== undefined) result[key] = finite(input[key], `${label}-${key}`);
  }
  return result;
}

function cumulativeHistogram(input, label) {
  assertion(object(input), `${label}-histogram-required`);
  assertion(Array.isArray(input.boundsMs) && input.boundsMs.length > 0 && input.boundsMs.length <= 64, `${label}-bounds-invalid`);
  assertion(Array.isArray(input.counts) && input.counts.length === input.boundsMs.length, `${label}-counts-invalid`);
  const boundsMs = input.boundsMs.map((value, index) => finite(value, `${label}-bound-${index}`, 1));
  for (let index = 1; index < boundsMs.length; index += 1) assertion(boundsMs[index] > boundsMs[index - 1], `${label}-bounds-not-increasing`);
  const counts = input.counts.map((value, index) => integer(value, `${label}-count-${index}`));
  const overflow = integer(input.overflow, `${label}-overflow`);
  const samples = integer(input.samples, `${label}-samples`);
  assertion(counts.reduce((total, value) => total + value, overflow) === samples, `${label}-sample-accounting-mismatch`);
  return { boundsMs, counts, overflow, samples };
}

function boundedCauses(input, label) {
  assertion(object(input), `${label}-required`);
  const result = {};
  for (const [cause, value] of Object.entries(input)) {
    assertion(KNOWN_CAUSES.has(cause), `${label}-cause-invalid:${cause}`);
    result[cause] = integer(value, `${label}-${cause}`);
  }
  return result;
}

function projectTarget(input, expectedEpoch) {
  assertion(object(input), "target-timing-invalid");
  const commissioningEpochId = string(input.commissioningEpochId, "target-commissioning-epoch", SAFE_ID);
  assertion(commissioningEpochId === expectedEpoch, "target-commissioning-epoch-mismatch");
  const targetId = string(input.targetId, "target-id", SAFE_ID);
  const validCompletions = integer(input.validCompletions, "target-valid-completions");
  const validRevisits = integer(input.validRevisits, "target-valid-revisits");
  const objectiveMetRevisits = integer(input.objectiveMetRevisits, "target-objective-met");
  const objectiveMissedRevisits = integer(input.objectiveMissedRevisits, "target-objective-missed");
  const objectiveBreaches = integer(input.objectiveBreaches, "target-objective-breaches");
  const unknownVisits = integer(input.unknownVisits, "target-unknown-visits");
  const missesByCause = boundedCauses(input.missesByCause, "target-miss-causes");
  const unknownsByCause = boundedCauses(input.unknownsByCause, "target-unknown-causes");
  const revisitHistogram = cumulativeHistogram(input.revisitHistogram, "target-revisit");
  const unobservedGapHistogram = cumulativeHistogram(input.unobservedGapHistogram, "target-gap");
  assertion(validRevisits === Math.max(0, validCompletions - 1), `target-valid-revisit-accounting-mismatch:${targetId}`);
  assertion(objectiveMetRevisits + objectiveMissedRevisits === validRevisits, `target-objective-accounting-mismatch:${targetId}`);
  assertion(objectiveMissedRevisits <= objectiveBreaches, `target-valid-late-exceeds-all-breaches:${targetId}`);
  assertion(Object.values(missesByCause).reduce((total, value) => total + value, 0) === objectiveBreaches, `target-breach-cause-accounting-mismatch:${targetId}`);
  assertion(Object.values(unknownsByCause).reduce((total, value) => total + value, 0) === unknownVisits, `target-unknown-cause-accounting-mismatch:${targetId}`);
  return {
    commissioningEpochId,
    targetId,
    objectiveMs: integer(input.objectiveMs, "target-objective", 1),
    validCompletions,
    validRevisits,
    objectiveMetRevisits,
    objectiveMissedRevisits,
    objectiveBreaches,
    unknownVisits,
    missesByCause,
    unknownsByCause,
    revisitHistogram,
    unobservedGapHistogram,
    revisitMs: distribution(input.revisitMs, "target-revisit"),
    unobservedGapMs: distribution(input.unobservedGapMs, "target-gap"),
  };
}

export function assertHealthMatchesBinding(raw, bindingInput) {
  const binding = validateQualificationBinding(bindingInput);
  assertion(object(raw) && raw.schemaVersion === 2, "health-schema-v2-required");
  const identity = raw.identity;
  assertion(object(identity) && identity.schemaVersion === 1, "health-runtime-identity-required");
  assertion(object(identity.release), "health-release-identity-required");
  assertion(identity.release.integrity === "release-metadata", "health-release-metadata-required");
  for (const [healthKey, bindingKey] of [
    ["buildId", "releaseBuildId"],
    ["serverBuildId", "serverBuildId"],
    ["clientBuildId", "clientBuildId"],
    ["sourceDigest", "sourceDigest"],
    ["packageDigest", "packageDigest"],
    ["dependencyLockDigest", "dependencyLockDigest"],
  ]) assertion(identity.release[healthKey] === binding[bindingKey], `health-${healthKey}-binding-mismatch`);
  assertion(object(identity.configuration), "health-configuration-identity-required");
  for (const key of ["configurationHash", "catalogVersion", "detectorRuleSetId", "expectedSampleRateHz"]) {
    assertion(identity.configuration[key] === binding[key], `health-${key}-binding-mismatch`);
  }
  assertion(object(raw.productionQualification), "health-production-qualification-required");
  assertion(raw.productionQualification.state !== "simulation", "health-simulation-qualification-refused");
  assertion(raw.productionQualification.siteBindingHash === binding.siteBindingHash, "health-site-binding-mismatch");
  assertion(raw.productionQualification.receiverModel === binding.receiverModel, "health-receiver-model-mismatch");
  assertion(raw.productionQualification.receiverIdentityHash === binding.receiverIdentityHash, "health-receiver-identity-mismatch");
  assertion(object(raw.productionQualification.requirements), "health-physical-qualification-requirements-required");
  assertion(raw.productionQualification.requirements.physicalReceiver === true, "health-physical-receiver-not-proven");
  assertion(raw.productionQualification.requirements.supportedReceiverModel === true, "health-supported-receiver-model-not-proven");
  assertion(raw.productionQualification.requirements.stableReceiverIdentity === true, "health-hardware-serial-identity-not-proven");
  return binding;
}

export function projectHealthSnapshot(raw, bindingInput, capture = {}) {
  const binding = assertHealthMatchesBinding(raw, bindingInput);
  const capturedAt = timestamp(capture.capturedAt ?? new Date().toISOString(), "sample-captured-at");
  const serverGeneratedAt = timestamp(raw.generatedAt, "health-generated-at");
  const commissioning = raw.schedule?.commissioning;
  assertion(object(commissioning), "health-commissioning-required");
  const commissioningEpochId = string(commissioning.epochId, "health-commissioning-epoch", SAFE_ID);
  assertion(Array.isArray(raw.schedule?.targets), "health-target-timing-required");
  const targets = raw.schedule.targets.map((target) => projectTarget(target, commissioningEpochId)).sort((left, right) => left.targetId.localeCompare(right.targetId));
  const expectedTargets = new Map(binding.tier1Targets.map((target) => [target.targetId, target.objectiveMs]));
  assertion(targets.length === expectedTargets.size, "health-tier1-target-count-mismatch");
  assertion(new Set(targets.map((target) => target.targetId)).size === targets.length, "health-tier1-target-duplicate");
  for (const target of targets) assertion(expectedTargets.get(target.targetId) === target.objectiveMs, `health-tier1-target-mismatch:${target.targetId}`);
  for (const targetId of expectedTargets.keys()) assertion(targets.some((target) => target.targetId === targetId), `health-tier1-target-missing:${targetId}`);
  const receiver = raw.receiverPath?.receivers;
  assertion(Array.isArray(receiver) && receiver.length === 1, "health-exactly-one-receiver-required");
  const data = raw.dataContinuity;
  assertion(object(data), "health-data-continuity-required");
  const networkInterfaces = raw.network?.interfaces;
  assertion(Array.isArray(networkInterfaces), "health-network-interfaces-required");
  const baselines = raw.schedule?.baselines;
  assertion(Array.isArray(baselines), "health-baselines-required");
  const baselineBindings = new Map(binding.tier1Targets.map((target) => [target.targetId, target.baselineFingerprintId]));
  const activeBaselines = baselines.filter((baseline) => baselineBindings.has(baseline.targetId));
  assertion(activeBaselines.length === baselineBindings.size, "health-baseline-count-mismatch");
  assertion(new Set(activeBaselines.map((baseline) => baseline.targetId)).size === activeBaselines.length, "health-baseline-target-duplicate");
  for (const [targetId, fingerprintId] of baselineBindings) {
    const baseline = activeBaselines.find((candidate) => candidate.targetId === targetId);
    assertion(baseline && baseline.fingerprintId === fingerprintId, `health-baseline-fingerprint-mismatch:${targetId}`);
  }
  const processing = object(raw.processing) ? raw.processing : {};
  const exportsCompatibility = object(raw.exports) ? raw.exports : {};
  const streamingCompatibility = object(raw.streaming) ? raw.streaming : {};
  const opsStatus = capture.opsStatus;
  assertion(object(opsStatus) && opsStatus.verified === true, "ops-supervisor-status-required");
  const opsGeneratedAt = timestamp(opsStatus.generatedAt, "ops-supervisor-generated-at");
  assertion(Math.abs(Date.parse(serverGeneratedAt) - Date.parse(opsGeneratedAt)) <= 120_000, "ops-supervisor-status-stale");
  assertion(opsStatus.clockSynchronized === true, "ops-supervisor-clock-not-synchronized");
  assertion(opsStatus.serviceActive === true, "ops-supervisor-service-not-active");
  return {
    schemaVersion: 1,
    sequence: integer(capture.sequence, "sample-sequence", 1),
    collectorBootId: string(capture.collectorBootId, "collector-boot-id", SAFE_ID),
    collectorMonotonicMs: finite(capture.collectorMonotonicMs, "collector-monotonic-ms"),
    capturedAt,
    serverGeneratedAt,
    serviceBootId: string(raw.identity.serviceBootId, "health-service-boot-id", SAFE_ID),
    serviceStartedAt: timestamp(raw.identity.serviceStartedAt, "health-service-started-at"),
    identityDigest: identityDigest(binding),
    commissioningEpochId,
    configurationEpoch: integer(raw.schedule.health?.configurationEpoch, "health-configuration-epoch", 1),
    tuneEpoch: integer(raw.schedule.health?.tuneEpoch, "health-tune-epoch"),
    currentHealth: {
      state: string(raw.currentHealth?.state, "health-current-state"),
      ready: raw.currentHealth?.ready === true,
      monitoringReady: raw.currentHealth?.monitoringReady === true,
      evidenceReady: raw.currentHealth?.evidenceReady === true,
    },
    commissioning: {
      state: string(commissioning.state, "health-commissioning-state"),
      ready: commissioning.ready === true,
      receiverReady: commissioning.receiverReady === true,
      sampleRateReady: commissioning.sampleRateReady === true,
      simulation: commissioning.simulation === true,
      dataDomain: commissioning.dataDomain,
      faults: Array.isArray(commissioning.faults) ? commissioning.faults.slice(0, 128).map((value) => string(value, "health-commissioning-fault")) : [],
    },
    receiver: {
      availability: raw.receiverPath.availability?.state,
      usb: receiver[0].usb,
      transport: receiver[0].transport,
      frames: receiver[0].frames,
      sampleRateMatches: receiver[0].sampleRateMatches === true,
      reconnectAttempts: integer(receiver[0].reconnectAttempts, "health-reconnect-attempts"),
      recoveryState: receiver[0].recoveryState,
    },
    continuity: {
      receivedFrames: counterTotal(data.receivedFrames, "health-received-frames"),
      analyzedObservations: counterTotal(data.analyzedObservations, "health-analyzed-observations"),
      invalidOrStaleFrames: counterTotal(data.invalidOrStaleFrames, "health-invalid-stale-frames"),
      unknownVisits: counterTotal(data.unknownVisits, "health-unknown-visits"),
      missedObjectives: counterTotal(data.missedObjectives, "health-missed-objectives"),
      evidenceFramesRecorded: counterTotal(data.evidenceFramesRecorded, "health-evidence-recorded"),
      evidenceFramesLost: counterTotal(data.evidenceFramesLost, "health-evidence-lost"),
      browserFramesDropped: counterTotal(data.browserFramesDropped, "health-browser-dropped"),
    },
    attribution: {
      acceptedInvariantViolations: integer(processing.acceptedAttributionInvariantViolations, "health-accepted-attribution-invariant-violations"),
      rejectedEpochFrames: integer(processing.invalidSpectrumFramesDropped ?? data.invalidOrStaleFrames.total, "health-rejected-epoch-frames"),
    },
    clock: {
      opsGeneratedAt,
      opsRecordSha256: string(opsStatus.recordSha256, "ops-supervisor-record-hash", HASH),
      synchronized: true,
      serviceRestarts: integer(opsStatus.serviceRestarts, "ops-supervisor-service-restarts"),
    },
    software: {
      rssBytes: finite(raw.software?.rssBytes, "health-rss"),
      heapUsedBytes: finite(raw.software?.heapUsedBytes, "health-heap"),
      externalBytes: finite(raw.software?.externalBytes, "health-external"),
      eventLoopP99Ms: finite(raw.software?.eventLoopDelayP99Ms, "health-event-loop-p99"),
      hostCpuPercent: finite(raw.software?.hostCpu?.current, "health-host-cpu"),
      hostCpu60Percent: finite(raw.software?.hostCpu?.average60s, "health-host-cpu-60s"),
      rfMonitorCpuPercent: finite(raw.software?.rfMonitorCpuHostNormalized?.current, "health-process-cpu"),
      rfMonitorCpu60Percent: finite(raw.software?.rfMonitorCpuHostNormalized?.average60s, "health-process-cpu-60s"),
    },
    network: {
      liveBytesPerSecond10s: finite(raw.network?.liveBytesPerSecond10s, "health-live-rate-10s"),
      liveBytesPerSecond60s: finite(raw.network?.liveBytesPerSecond60s, "health-live-rate-60s"),
      applicationBytesPerSecond10s: finite(raw.network?.applicationBytesPerSecond10s, "health-app-rate-10s"),
      applicationBytesPerSecond60s: finite(raw.network?.applicationBytesPerSecond60s, "health-app-rate-60s"),
      dashboards: integer(raw.network?.dashboards, "health-dashboards"),
      queuedBytes: integer(raw.network?.queuedBytes, "health-client-queued-bytes"),
      applicationDrops: counterTotal(raw.network?.drops, "health-network-drops"),
      interfaces: networkInterfaces.map((item) => ({
        id: string(item.id, "health-interface-id", SAFE_ID),
        state: item.state,
        receiveErrors: counterTotal(item.receiveErrors, "health-interface-rx-errors"),
        transmitErrors: counterTotal(item.transmitErrors, "health-interface-tx-errors"),
        receiveDrops: counterTotal(item.receiveDrops, "health-interface-rx-drops"),
        transmitDrops: counterTotal(item.transmitDrops, "health-interface-tx-drops"),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      rejectedClients: integer(streamingCompatibility.rejectedClients ?? 0, "health-rejected-clients"),
    },
    evidence: {
      healthy: raw.evidence?.healthy === true,
      writerQueueItems: integer(raw.evidence?.writerQueueItems, "health-writer-items"),
      writerQueueBytes: integer(raw.evidence?.writerQueueBytes, "health-writer-bytes"),
      writerOldestAgeMs: finite(raw.evidence?.writerOldestAgeMs, "health-writer-age"),
      diskFreeBytes: finite(raw.evidence?.diskFreeBytes, "health-disk-free"),
      diskReserveBytes: finite(raw.evidence?.diskReserveBytes, "health-disk-reserve"),
      diskPressure: raw.evidence?.diskPressure === true,
      exportsActive: integer(raw.evidence?.exportsActive, "health-exports-active"),
      exportsQueued: integer(raw.evidence?.exportsQueued, "health-exports-queued"),
      exportDownloadActive: exportsCompatibility.activeDownload === true,
    },
    schedule: {
      profile: raw.schedule.health?.profile,
      optionalWorkAdmitted: raw.schedule.health?.optionalWorkAdmitted === true,
      targets,
      baselines: activeBaselines.map((baseline) => ({
        targetId: string(baseline.targetId, "health-baseline-target-id", SAFE_ID),
        lifecycle: string(baseline.lifecycle, "health-baseline-lifecycle"),
        fingerprintId: string(baseline.fingerprintId, "health-baseline-fingerprint", HASH),
        representativeHours: integer(baseline.representativeHours, "health-baseline-hours"),
        validCoverageRatio: finite(baseline.validCoverageRatio, "health-baseline-coverage"),
      })).sort((left, right) => left.targetId.localeCompare(right.targetId)),
    },
    recovery: {
      receiver: raw.recovery?.receiver?.outcome,
      application: raw.recovery?.application?.outcome,
    },
  };
}

/**
 * V7 is an installed-chain gate. Reject non-physical input before a run
 * directory is created, and repeat the same checks for every collected
 * sample in sampleHealthy(). The bound receiver identity is already checked
 * by assertHealthMatchesBinding().
 */
export function assertV7PhysicalSnapshot(sample) {
  assertion(object(sample), "v7-physical-snapshot-required");
  assertion(sample.commissioning?.simulation === false, "v7-simulation-refused");
  assertion(sample.commissioning?.dataDomain === "field", "v7-field-domain-required");
  assertion(sample.commissioning?.receiverReady === true, "v7-physical-receiver-not-ready");
  assertion(sample.commissioning?.sampleRateReady === true, "v7-sample-rate-not-confirmed");
  assertion(sample.receiver?.availability === "available", "v7-receiver-unavailable");
  assertion(sample.receiver?.usb === "present", "v7-usb-not-present");
  assertion(sample.receiver?.transport === "connected", "v7-sdrconnect-not-connected");
  assertion(sample.receiver?.frames === "live", "v7-live-rf-frames-required");
  assertion(sample.receiver?.sampleRateMatches === true, "v7-sample-rate-mismatch");
  return sample;
}

function delta(first, last, label) {
  assertion(Number.isFinite(first) && Number.isFinite(last), `${label}-missing`);
  assertion(last >= first, `${label}-counter-reset`);
  return last - first;
}

function nondecreasing(previous, current, label) {
  assertion(Number.isFinite(previous) && Number.isFinite(current), `${label}-missing`);
  assertion(current >= previous, `${label}-counter-reset`);
}

function histogramDelta(first, last, label) {
  assertion(canonicalJson(first.boundsMs) === canonicalJson(last.boundsMs), `${label}-bounds-changed`);
  const counts = last.counts.map((value, index) => delta(first.counts[index], value, `${label}-bucket-${index}`));
  const overflow = delta(first.overflow, last.overflow, `${label}-overflow`);
  const samples = delta(first.samples, last.samples, `${label}-samples`);
  assertion(counts.reduce((total, value) => total + value, overflow) === samples, `${label}-delta-accounting-mismatch`);
  return { boundsMs: last.boundsMs, counts, overflow, samples };
}

/**
 * Enforce the cumulative, one-epoch contract while samples are being
 * collected. Final analysis repeats these checks so copied or hand-edited
 * JSONL cannot bypass the live collector.
 */
export function assertQualificationSampleProgress(previous, current) {
  assertion(object(previous) && object(current), "qualification-sample-progress-required");
  assertion(current.sequence === previous.sequence + 1, "qualification-sample-sequence-gap");
  assertion(Date.parse(current.serverGeneratedAt) > Date.parse(previous.serverGeneratedAt), "qualification-server-time-regressed");
  assertion(Date.parse(current.capturedAt) >= Date.parse(previous.capturedAt), "qualification-collector-wall-time-regressed");
  assertion(current.collectorBootId === previous.collectorBootId, "qualification-collector-boot-changed");
  assertion(current.collectorMonotonicMs > previous.collectorMonotonicMs, "qualification-collector-monotonic-regressed");
  assertion(current.identityDigest === previous.identityDigest, "qualification-identity-changed");
  assertion(current.serviceBootId === previous.serviceBootId, "qualification-service-boot-changed");
  assertion(current.serviceStartedAt === previous.serviceStartedAt, "qualification-service-start-time-changed");
  assertion(current.commissioningEpochId === previous.commissioningEpochId, "qualification-commissioning-epoch-changed");
  assertion(current.configurationEpoch === previous.configurationEpoch, "qualification-configuration-epoch-changed");
  nondecreasing(previous.tuneEpoch, current.tuneEpoch, "qualification-tune-epoch");
  assertion(Date.parse(current.clock.opsGeneratedAt) >= Date.parse(previous.clock.opsGeneratedAt), "qualification-ops-clock-record-regressed");
  assertion(current.clock.serviceRestarts === previous.clock.serviceRestarts, "qualification-ops-service-restart-count-changed");

  for (const key of ["receivedFrames", "analyzedObservations", "invalidOrStaleFrames", "unknownVisits", "missedObjectives", "evidenceFramesRecorded", "evidenceFramesLost", "browserFramesDropped"]) {
    nondecreasing(previous.continuity[key], current.continuity[key], `qualification-continuity-${key}`);
  }
  nondecreasing(previous.attribution.acceptedInvariantViolations, current.attribution.acceptedInvariantViolations, "qualification-accepted-attribution-invariant");
  nondecreasing(previous.attribution.rejectedEpochFrames, current.attribution.rejectedEpochFrames, "qualification-rejected-epoch-frames");
  nondecreasing(previous.receiver.reconnectAttempts, current.receiver.reconnectAttempts, "qualification-receiver-reconnect-attempts");
  nondecreasing(previous.network.applicationDrops, current.network.applicationDrops, "qualification-network-application-drops");

  const previousInterfaces = new Map(previous.network.interfaces.map((item) => [item.id, item]));
  assertion(previousInterfaces.size === current.network.interfaces.length, "qualification-network-interface-set-changed");
  for (const item of current.network.interfaces) {
    const prior = previousInterfaces.get(item.id);
    assertion(prior, `qualification-network-interface-added:${item.id}`);
    for (const key of ["receiveErrors", "transmitErrors", "receiveDrops", "transmitDrops"]) {
      nondecreasing(prior[key], item[key], `qualification-network-${item.id}-${key}`);
    }
  }

  const previousTargets = new Map(previous.schedule.targets.map((target) => [target.targetId, target]));
  assertion(previousTargets.size === current.schedule.targets.length, "qualification-target-set-changed");
  for (const target of current.schedule.targets) {
    const prior = previousTargets.get(target.targetId);
    assertion(prior, `qualification-target-added:${target.targetId}`);
    assertion(target.commissioningEpochId === prior.commissioningEpochId && target.objectiveMs === prior.objectiveMs, `qualification-target-binding-changed:${target.targetId}`);
    for (const key of ["validCompletions", "validRevisits", "objectiveMetRevisits", "objectiveMissedRevisits", "objectiveBreaches", "unknownVisits"]) {
      nondecreasing(prior[key], target[key], `qualification-target-${target.targetId}-${key}`);
    }
    for (const cause of KNOWN_CAUSES) {
      nondecreasing(prior.missesByCause[cause] ?? 0, target.missesByCause[cause] ?? 0, `qualification-target-${target.targetId}-miss-${cause}`);
      nondecreasing(prior.unknownsByCause[cause] ?? 0, target.unknownsByCause[cause] ?? 0, `qualification-target-${target.targetId}-unknown-${cause}`);
    }
    for (const histogramName of ["revisitHistogram", "unobservedGapHistogram"]) {
      const priorHistogram = prior[histogramName];
      const currentHistogram = target[histogramName];
      assertion(canonicalJson(currentHistogram.boundsMs) === canonicalJson(priorHistogram.boundsMs), `qualification-target-${target.targetId}-${histogramName}-bounds-changed`);
      nondecreasing(priorHistogram.samples, currentHistogram.samples, `qualification-target-${target.targetId}-${histogramName}-samples`);
      nondecreasing(priorHistogram.overflow, currentHistogram.overflow, `qualification-target-${target.targetId}-${histogramName}-overflow`);
      for (let index = 0; index < currentHistogram.counts.length; index += 1) {
        nondecreasing(priorHistogram.counts[index], currentHistogram.counts[index], `qualification-target-${target.targetId}-${histogramName}-bucket-${index}`);
      }
    }
  }

  const previousBaselines = new Map(previous.schedule.baselines.map((baseline) => [baseline.targetId, baseline]));
  assertion(previousBaselines.size === current.schedule.baselines.length, "qualification-baseline-set-changed");
  for (const baseline of current.schedule.baselines) {
    const prior = previousBaselines.get(baseline.targetId);
    assertion(prior && prior.fingerprintId === baseline.fingerprintId, `qualification-baseline-fingerprint-changed:${baseline.targetId}`);
    nondecreasing(prior.representativeHours, baseline.representativeHours, `qualification-baseline-${baseline.targetId}-representative-hours`);
  }
  return true;
}

function percentile(values, ratio) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function maximum(values) {
  if (!values.length) return undefined;
  let result = -Infinity;
  for (const value of values) if (value > result) result = value;
  return result;
}

function linearSlopePerHour(points) {
  if (points.length < 2) return undefined;
  const x0 = points[0].atMs;
  const xs = points.map((point) => (point.atMs - x0) / 3_600_000);
  const meanX = xs.reduce((total, value) => total + value, 0) / xs.length;
  const meanY = points.reduce((total, point) => total + point.value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < points.length; index += 1) {
    numerator += (xs[index] - meanX) * (points[index].value - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  return denominator === 0 ? undefined : numerator / denominator;
}

function sampleHealthy(sample) {
  const blockingCommissioningFaults = sample.commissioning.faults.filter((fault) => (
    fault !== "rf-epoch-frame-rejected"
    && !fault.startsWith("tier1-objective-miss:")
    && !fault.startsWith("unknown-visit:")
  ));
  return sample.currentHealth.monitoringReady
    && sample.currentHealth.evidenceReady
    && sample.commissioning.receiverReady
    && sample.commissioning.sampleRateReady
    && !sample.commissioning.simulation
    && sample.commissioning.dataDomain === "field"
    && blockingCommissioningFaults.length === 0
    && sample.clock.synchronized === true
    && sample.receiver.availability === "available"
    && sample.receiver.usb === "present"
    && sample.receiver.transport === "connected"
    && sample.receiver.frames === "live"
    && sample.receiver.sampleRateMatches
    && sample.evidence.healthy
    && !sample.evidence.diskPressure;
}

function representativeHealthyHours(samples) {
  const observationStart = Date.parse(samples[0].serverGeneratedAt);
  const buckets = new Map();
  for (const sample of samples) {
    const atMs = Date.parse(sample.serverGeneratedAt);
    const hourStart = observationStart + Math.floor((atMs - observationStart) / 3_600_000) * 3_600_000;
    const bucket = buckets.get(hourStart) ?? { samples: 0, healthy: true, firstAt: atMs, lastAt: atMs, firstSample: sample, lastSample: sample };
    bucket.samples += 1;
    bucket.healthy &&= sampleHealthy(sample);
    bucket.firstAt = Math.min(bucket.firstAt, atMs);
    bucket.lastAt = Math.max(bucket.lastAt, atMs);
    if (atMs <= bucket.firstAt) bucket.firstSample = sample;
    if (atMs >= bucket.lastAt) bucket.lastSample = sample;
    buckets.set(hourStart, bucket);
  }
  const requiredSamples = Math.floor((3_600_000 / SAMPLE_INTERVAL_MS) * 0.8);
  return [...buckets.entries()].filter(([hourStart, bucket]) => {
    const unknownFree = bucket.firstSample.schedule.targets.every((target) => {
      const ending = bucket.lastSample.schedule.targets.find((candidate) => candidate.targetId === target.targetId);
      return ending && ending.unknownVisits === target.unknownVisits;
    });
    return bucket.healthy
      && unknownFree
      && bucket.lastSample.receiver.reconnectAttempts === bucket.firstSample.receiver.reconnectAttempts
      && bucket.samples >= requiredSamples
      && bucket.firstAt <= hourStart + SAMPLE_INTERVAL_MS
      && bucket.lastAt >= hourStart + 3_600_000 - MAX_SAMPLE_GAP_MS;
  }).map(([hourStart]) => new Date(hourStart).toISOString());
}

function monotonicSeries(samples, pathGetter, label, findings) {
  let prior = pathGetter(samples[0]);
  for (const sample of samples.slice(1)) {
    const current = pathGetter(sample);
    if (current < prior) findings.push({ code: `${label}-counter-reset`, at: sample.serverGeneratedAt, value: current, previous: prior });
    prior = current;
  }
}

function validateContinuity(samples, findings) {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const serverGapMs = Date.parse(current.serverGeneratedAt) - Date.parse(previous.serverGeneratedAt);
    if (serverGapMs <= 0 || serverGapMs > MAX_SAMPLE_GAP_MS) findings.push({ code: serverGapMs <= 0 ? "server-clock-backward" : "sample-gap", at: current.serverGeneratedAt, value: serverGapMs, limit: MAX_SAMPLE_GAP_MS });
    if (current.collectorBootId === previous.collectorBootId) {
      const monotonicGap = current.collectorMonotonicMs - previous.collectorMonotonicMs;
      if (monotonicGap < 0 || Math.abs(serverGapMs - monotonicGap) > 2_000) findings.push({ code: "clock-jump", at: current.serverGeneratedAt, value: serverGapMs - monotonicGap, limit: 2_000 });
    }
    if (Date.parse(current.clock.opsGeneratedAt) < Date.parse(previous.clock.opsGeneratedAt)) findings.push({ code: "ops-clock-record-regressed", at: current.serverGeneratedAt });
  }
}

function ensureStableIdentity(samples, binding, findings) {
  const expectedDigest = identityDigest(binding);
  const first = samples[0];
  for (const sample of samples) {
    if (sample.identityDigest !== expectedDigest) findings.push({ code: "identity-binding-changed", at: sample.serverGeneratedAt });
    if (sample.collectorBootId !== first.collectorBootId) findings.push({ code: "collector-boot-changed", at: sample.serverGeneratedAt });
    if (sample.serviceBootId !== first.serviceBootId) findings.push({ code: "service-boot-changed", at: sample.serverGeneratedAt });
    if (sample.serviceStartedAt !== first.serviceStartedAt) findings.push({ code: "service-start-time-changed", at: sample.serverGeneratedAt });
    if (sample.commissioningEpochId !== first.commissioningEpochId) findings.push({ code: "commissioning-epoch-changed", at: sample.serverGeneratedAt });
    if (sample.configurationEpoch !== first.configurationEpoch) findings.push({ code: "configuration-epoch-changed", at: sample.serverGeneratedAt });
    if (sample.clock.serviceRestarts !== first.clock.serviceRestarts) findings.push({ code: "ops-service-restart-count-changed", at: sample.serverGeneratedAt });
    if (Date.parse(sample.clock.opsGeneratedAt) < Date.parse(first.clock.opsGeneratedAt)) findings.push({ code: "ops-clock-record-regressed", at: sample.serverGeneratedAt });
    for (const targetBinding of binding.tier1Targets) {
      const baseline = sample.schedule.baselines.filter((item) => item.targetId === targetBinding.targetId);
      if (baseline.length !== 1 || baseline[0].fingerprintId !== targetBinding.baselineFingerprintId) findings.push({ code: "baseline-fingerprint-changed", at: sample.serverGeneratedAt, targetId: targetBinding.targetId });
    }
  }
}

function validateEvidenceFileManifest(record, label) {
  assertion(Array.isArray(record.evidenceFiles) && record.evidenceFiles.length > 0 && record.evidenceFiles.length <= 256, `${label}-evidence-files-required`);
  const paths = new Set();
  for (const [index, entry] of record.evidenceFiles.entries()) {
    assertion(object(entry), `${label}-evidence-file-${index}-invalid`);
    const relativePath = string(entry.path, `${label}-evidence-file-${index}-path`);
    assertion(!relativePath.startsWith("/") && !relativePath.includes("\\") && !relativePath.includes("\0"), `${label}-evidence-path-invalid:${relativePath}`);
    const segments = relativePath.split("/");
    assertion(segments.every((segment) => segment && segment !== "." && segment !== ".."), `${label}-evidence-path-invalid:${relativePath}`);
    assertion(!paths.has(relativePath), `${label}-evidence-path-duplicate:${relativePath}`);
    paths.add(relativePath);
    string(entry.sha256, `${label}-evidence-file-${index}-hash`, HASH);
  }
  return record.evidenceFiles;
}

function validateExternalRecordBase(record, kind, binding, witnessPublicKeyPem) {
  assertion(object(record) && record.schemaVersion === 1 && record.kind === kind, `${kind}-record-invalid`);
  const digest = identityDigest(binding);
  assertion(record.identityDigest === digest, `${kind}-identity-mismatch`);
  timestamp(record.completedAt, `${kind}-completed-at`);
  assertion(record.outcome === "PASS", `${kind}-not-pass`);
  assertion(object(record.witness), `${kind}-witness-required`);
  assertion(record.witness.id === binding.qualificationWitnessId, `${kind}-witness-id-mismatch`);
  assertion(record.witness.algorithm === "Ed25519", `${kind}-witness-algorithm-invalid`);
  timestamp(record.witness.signedAt, `${kind}-witness-signed-at`);
  assertion(Date.parse(record.witness.signedAt) >= Date.parse(record.completedAt), `${kind}-witness-signed-before-completion`);
  assertion(record.witness.publicKeySha256 === binding.qualificationWitnessPublicKeySha256, `${kind}-witness-key-binding-mismatch`);
  assertion(witnessPublicKeyDigest(witnessPublicKeyPem) === binding.qualificationWitnessPublicKeySha256, `${kind}-supplied-witness-key-mismatch`);
  const signature = string(record.witness.signatureBase64, `${kind}-witness-signature`);
  assertion(/^[A-Za-z0-9+/]+={0,2}$/.test(signature), `${kind}-witness-signature-invalid`);
  assertion(verifySignature(null, Buffer.from(signedRecordPayload(record)), createPublicKey(witnessPublicKeyPem), Buffer.from(signature, "base64")), `${kind}-witness-signature-failed`);
  validateEvidenceFileManifest(record, kind);
  return record;
}

export function validateV7Prerequisites(record, binding, witnessPublicKeyPem) {
  validateExternalRecordBase(record, "rf-monitor-v7-prerequisites", binding, witnessPublicKeyPem);
  assertion(record.installedChainFingerprintSha256 === binding.installedChainFingerprintSha256, "v7-prerequisites-installed-chain-mismatch");
  assertion(Array.isArray(record.gates) && record.gates.length === 7, "v7-prerequisites-seven-gates-required");
  const evidenceHashes = new Set(record.evidenceFiles.map((entry) => entry.sha256));
  const gateArtifactHashes = new Set();
  const gates = new Map(record.gates.map((entry) => {
    assertion(object(entry) && /^V[0-6]$/.test(entry.gate) && entry.outcome === "PASS", "v7-prerequisite-gate-invalid");
    string(entry.artifactSha256, `v7-prerequisite-${entry.gate}-artifact`, HASH);
    assertion(!gateArtifactHashes.has(entry.artifactSha256), `v7-prerequisite-artifact-duplicate:${entry.gate}`);
    gateArtifactHashes.add(entry.artifactSha256);
    assertion(evidenceHashes.has(entry.artifactSha256), `v7-prerequisite-${entry.gate}-artifact-not-in-custody`);
    return [entry.gate, entry];
  }));
  for (let index = 0; index <= 6; index += 1) assertion(gates.has(`V${index}`), `v7-prerequisite-gate-missing:V${index}`);
  assertion(gates.size === 7, "v7-prerequisite-gate-duplicate");
  assertion(object(record.claims), "v7-prerequisite-claims-required");
  assertion(record.claims.v2AcceptedAttributionInvariantViolations === 0, "v7-prerequisite-v2-attribution-invariant-missing");
  assertion(record.claims.v5RealReceiverDerivedFftOnly === true, "v7-prerequisite-v5-real-receiver-fft-missing");
  assertion(record.claims.v5SyntheticOrTestInputsAccepted === 0, "v7-prerequisite-v5-synthetic-input-refused");
  assertion(record.claims.v6PhysicalInstalledChain === true, "v7-prerequisite-v6-installed-chain-missing");
  assertion(record.claims.v6InstalledChainFingerprintSha256 === binding.installedChainFingerprintSha256, "v7-prerequisite-v6-chain-fingerprint-mismatch");
  return record;
}

function validateFaultCases(record, requiredCases) {
  const phaseStartedAt = Date.parse(timestamp(record.phaseStartedAt, "fault-matrix-phase-start"));
  const phaseEndedAt = Date.parse(timestamp(record.phaseEndedAt, "fault-matrix-phase-end"));
  assertion(phaseEndedAt > phaseStartedAt && Date.parse(record.completedAt) >= phaseEndedAt, "fault-matrix-phase-chronology-invalid");
  assertion(Array.isArray(record.cases) && record.cases.length === requiredCases.length, "fault-matrix-cases-required");
  const evidenceHashes = new Set(record.evidenceFiles.map((entry) => entry.sha256));
  const cases = new Map(record.cases.map((entry) => {
    assertion(object(entry), "fault-matrix-case-invalid");
    const id = string(entry.id, "fault-matrix-case-id", SAFE_ID);
    assertion(entry.outcome === "PASS", `fault-matrix-case-not-pass:${id}`);
    string(entry.evidenceSha256, `fault-matrix-case-evidence:${id}`, HASH);
    assertion(evidenceHashes.has(entry.evidenceSha256), `fault-matrix-case-evidence-not-in-custody:${id}`);
    const executedAt = Date.parse(timestamp(entry.executedAt, `fault-matrix-case-executed-at:${id}`));
    assertion(executedAt >= phaseStartedAt && executedAt <= phaseEndedAt, `fault-matrix-case-outside-phase:${id}`);
    return [id, entry];
  }));
  for (const id of requiredCases) assertion(cases.has(id), `fault-matrix-case-missing:${id}`);
  assertion(cases.size === requiredCases.length, "fault-matrix-unrecognized-or-duplicate-cases");
  return { phaseStartedAt, phaseEndedAt, cases };
}

/** Required, independently witnessed fault/recovery evidence completed before V7. */
export function validateV7FaultRecoveryMatrix(record, binding, witnessPublicKeyPem) {
  validateExternalRecordBase(record, "rf-monitor-v7-fault-recovery-matrix", binding, witnessPublicKeyPem);
  string(record.faultPhaseId, "v7-fault-phase-id", SAFE_ID);
  validateFaultCases(record, REQUIRED_V7_FAULT_CASES);
  assertion(object(record.acceptance), "v7-fault-recovery-acceptance-required");
  assertion(finite(record.acceptance.stalledReceiverDetectionMaxMs, "v7-stalled-receiver-detection") <= 10_000, "v7-stalled-receiver-detection-limit");
  assertion(finite(record.acceptance.recoveryStartMaxMs, "v7-recovery-start") <= 30_000, "v7-recovery-start-limit");
  assertion(finite(record.acceptance.receiverRestorationMaxMs, "v7-receiver-restoration") <= 120_000, "v7-receiver-restoration-limit");
  assertion(record.acceptance.terminalFailuresVisible === true, "v7-terminal-failure-visibility-not-proven");
  assertion(integer(record.acceptance.restartLoops, "v7-restart-loops") === 0, "v7-restart-loop-observed");
  assertion(integer(record.acceptance.evidenceFramesLost, "v7-fault-evidence-loss") === 0, "v7-fault-evidence-loss");
  return record;
}

function validateSwitchCounters(record, kind, binding, witnessPublicKeyPem, runStartMs, runEndMs) {
  validateExternalRecordBase(record, kind, binding, witnessPublicKeyPem);
  const beforeMs = Date.parse(timestamp(record.capturedBeforeAt, "switch-before-at"));
  const afterMs = Date.parse(timestamp(record.capturedAfterAt, "switch-after-at"));
  assertion(afterMs > beforeMs && Date.parse(record.completedAt) >= afterMs, "switch-counter-chronology-invalid");
  assertion(beforeMs <= runStartMs && afterMs >= runEndMs, "switch-counters-do-not-bracket-run");
  assertion(Array.isArray(record.ports) && record.ports.length > 0 && record.ports.length <= 32, "switch-ports-invalid");
  const portIds = new Set();
  for (const port of record.ports) {
    assertion(object(port), "switch-port-invalid");
    const portId = string(port.portId, "switch-port-id", SAFE_ID);
    assertion(!portIds.has(portId), `switch-port-duplicate:${portId}`);
    portIds.add(portId);
    for (const key of ["egressDropsDelta", "egressDiscardsDelta", "pauseFramesDelta", "inputErrorsDelta", "inputDiscardsDelta", "portResetsDelta"]) {
      assertion(integer(port[key], `switch-${key}`) === 0, `switch-${key}-nonzero:${port.portId}`);
    }
    finite(port.linkSpeedMbps, "switch-link-speed", 1);
    assertion(port.fullDuplex === true, `switch-not-full-duplex:${port.portId}`);
  }
  string(record.evidenceSha256, "switch-evidence", HASH);
  assertion(record.evidenceFiles.some((entry) => entry.sha256 === record.evidenceSha256), "switch-evidence-not-in-custody");
  return record;
}

export function validateV7SwitchCounters(record, binding, witnessPublicKeyPem, runStartMs, runEndMs) {
  return validateSwitchCounters(record, "rf-monitor-v7-switch-counters", binding, witnessPublicKeyPem, runStartMs, runEndMs);
}

function validateBackupRestore(record, kind, binding, witnessPublicKeyPem, runStartMs, faultMatrix, boundedDevelopment) {
  validateExternalRecordBase(record, kind, binding, witnessPublicKeyPem);
  const completedAt = Date.parse(record.completedAt);
  assertion(completedAt <= runStartMs, "backup-restore-must-precede-run");
  assertion(record.faultPhaseId === faultMatrix.faultPhaseId, "backup-restore-fault-phase-mismatch");
  const phaseStartedAt = Date.parse(faultMatrix.phaseStartedAt);
  const phaseEndedAt = Date.parse(faultMatrix.phaseEndedAt);
  assertion(completedAt >= phaseStartedAt && completedAt <= phaseEndedAt, "backup-restore-outside-fault-phase");
  assertion(object(record.backup) && record.backup.outcome === "PASS", "backup-proof-not-pass");
  assertion(object(record.restore) && record.restore.outcome === "PASS", "restore-proof-not-pass");
  const backupAt = Date.parse(timestamp(record.backup.performedAt, "backup-performed-at"));
  const restoreAt = Date.parse(timestamp(record.restore.performedAt, "restore-performed-at"));
  assertion(backupAt >= phaseStartedAt && backupAt <= phaseEndedAt, "backup-outside-fault-phase");
  assertion(restoreAt >= backupAt && restoreAt <= phaseEndedAt && completedAt >= restoreAt, "restore-fault-phase-chronology-invalid");
  string(record.backup.packageSha256, "backup-package-hash", HASH);
  string(record.backup.verificationSha256, "backup-verification-hash", HASH);
  string(record.restore.verificationSha256, "restore-verification-hash", HASH);
  const recoveryTimeSeconds = finite(record.restore.recoveryTimeSeconds, "restore-recovery-time");
  assertion(record.restore.fieldTestDomainsSeparated === true, "restore-domain-separation-not-proven");
  assertion(record.restore.evidenceVerified === true, "restore-evidence-not-verified");
  if (boundedDevelopment) {
    assertion(record.backup.offHost === true, "v7-off-host-backup-not-proven");
    assertion(record.backup.independentlyVerified === true, "v7-backup-independent-verification-required");
    assertion(finite(record.backup.recoveryPointAgeSeconds, "v7-backup-recovery-point-age") <= 3_600, "v7-backup-rpo-limit");
    assertion(record.restore.independentlyVerified === true, "v7-restore-independent-verification-required");
    assertion(recoveryTimeSeconds <= 14_400, "v7-restore-rto-limit");
  }
  const evidenceHashes = new Set(record.evidenceFiles.map((entry) => entry.sha256));
  const requiredEvidence = [record.backup.packageSha256, record.backup.verificationSha256, record.restore.verificationSha256];
  assertion(new Set(requiredEvidence).size === requiredEvidence.length, "backup-restore-requires-distinct-evidence-files");
  for (const digest of requiredEvidence) assertion(evidenceHashes.has(digest), "backup-restore-evidence-not-in-custody");
  return record;
}

export function validateV7BackupRestore(record, binding, witnessPublicKeyPem, runStartMs, faultMatrix) {
  return validateBackupRestore(record, "rf-monitor-v7-backup-restore", binding, witnessPublicKeyPem, runStartMs, faultMatrix, true);
}

function validateLoadExercise(record, kind, binding, witnessPublicKeyPem, runStartMs, runEndMs, boundedDevelopment) {
  validateExternalRecordBase(record, kind, binding, witnessPublicKeyPem);
  const startedAt = Date.parse(timestamp(record.startedAt, "load-exercise-started-at"));
  const endedAt = Date.parse(timestamp(record.endedAt, "load-exercise-ended-at"));
  assertion(Date.parse(record.completedAt) >= endedAt, "load-exercise-chronology-invalid");
  assertion(startedAt >= runStartMs && endedAt <= runEndMs && endedAt > startedAt, "load-exercise-outside-run");
  assertion(record.engineerDashboards === 8, "load-exercise-eight-dashboards-required");
  assertion(record.alertEvidenceRateHz >= 4, "load-exercise-4hz-alert-evidence-required");
  assertion(record.exportDownloadBytesPerSecond === 5 * 1024 * 1024, "load-exercise-5mib-export-required");
  assertion(record.evidenceLoss === 0, "load-exercise-evidence-loss");
  if (boundedDevelopment) {
    assertion(record.ninthDashboardRejected === true, "v7-load-ninth-dashboard-not-rejected");
    assertion(finite(record.liveTrafficBytesPerSecond, "v7-load-live-traffic") <= LIVE_BANDWIDTH_LIMIT_BYTES_PER_SECOND, "v7-load-live-traffic-limit");
    assertion(finite(record.liveBurstBytes, "v7-load-live-burst") <= 2 * 1024 * 1024, "v7-load-live-burst-limit");
    assertion(finite(record.applicationEgressBytesPerSecond, "v7-load-application-egress") <= APPLICATION_EGRESS_LIMIT_BYTES_PER_SECOND, "v7-load-application-egress-limit");
    assertion(finite(record.visibleDiagnosticsBytesPerSecondPerClient, "v7-load-diagnostics-traffic") < 16 * 1024, "v7-load-diagnostics-traffic-limit");
    assertion(integer(record.maxPerClientQueuedBytes, "v7-load-per-client-queue") <= 256 * 1024, "v7-load-per-client-queue-limit");
    assertion(integer(record.maxControlStateBytes, "v7-load-control-state") <= 128 * 1024, "v7-load-control-state-limit");
    assertion(integer(record.maxWriterQueueItems, "v7-load-writer-items") < WRITER_QUEUE_ITEMS_LIMIT, "v7-load-writer-items-limit");
    assertion(integer(record.maxWriterQueueBytes, "v7-load-writer-bytes") < WRITER_QUEUE_BYTES_LIMIT, "v7-load-writer-bytes-limit");
    assertion(finite(record.maxWriterAgeMs, "v7-load-writer-age") < WRITER_AGE_LIMIT_MS, "v7-load-writer-age-limit");
    assertion(finite(record.maxSpectrumRingSeconds, "v7-load-spectrum-ring-seconds") <= 60, "v7-load-spectrum-ring-duration-limit");
    assertion(finite(record.maxSpectrumRingRateHz, "v7-load-spectrum-ring-rate") <= 4, "v7-load-spectrum-ring-rate-limit");
    assertion(integer(record.maxWaterfallRowsPerTarget, "v7-load-waterfall-rows") <= 32, "v7-load-waterfall-row-limit");
    assertion(integer(record.maxStoredSpectrumBins, "v7-load-stored-bins") <= 2_048, "v7-load-stored-bin-limit");
    assertion(integer(record.maxRawChunkBytes, "v7-load-raw-chunk") <= 128 * 1024 * 1024, "v7-load-raw-chunk-limit");
    assertion(integer(record.maxSessionBytes, "v7-load-session-bytes") <= 2 * 1024 * 1024 * 1024, "v7-load-session-byte-limit");
    assertion(integer(record.maxSessionDurationMs, "v7-load-session-duration") <= 24 * 60 * 60_000, "v7-load-session-duration-limit");
    assertion(integer(record.maxIncidentExportPartBytes, "v7-load-export-part") <= 256 * 1024 * 1024, "v7-load-export-part-limit");
    assertion(integer(record.alertEvidenceLoss, "v7-load-alert-evidence-loss") === 0, "v7-load-alert-evidence-loss");
    const clearRecorded = integer(record.clearEvidenceFramesRecorded, "v7-load-clear-evidence-recorded", 1);
    const clearLost = integer(record.clearEvidenceFramesLost, "v7-load-clear-evidence-lost");
    assertion(clearLost / (clearRecorded + clearLost) < 0.001, "v7-load-clear-evidence-loss-limit");
  }
  string(record.evidenceSha256, "load-exercise-evidence", HASH);
  assertion(record.evidenceFiles.some((entry) => entry.sha256 === record.evidenceSha256), "load-exercise-evidence-not-in-custody");
  return record;
}

export function validateV7LoadExercise(record, binding, witnessPublicKeyPem, runStartMs, runEndMs) {
  return validateLoadExercise(record, "rf-monitor-v7-load-exercise", binding, witnessPublicKeyPem, runStartMs, runEndMs, true);
}

function analyzeResourceAcceptance(ordered, findings, loadExercise) {
  const first = ordered[0];
  const last = ordered.at(-1);
  const rss = ordered.map((sample) => sample.software.rssBytes);
  const heap = ordered.map((sample) => sample.software.heapUsedBytes);
  const externalBuffers = ordered.map((sample) => sample.software.externalBytes);
  const hostCpu60 = ordered.map((sample) => sample.software.hostCpu60Percent);
  const processCpu60 = ordered.map((sample) => sample.software.rfMonitorCpu60Percent);
  const normalLoop = ordered.filter((sample) => !sample.evidence.exportDownloadActive && sample.evidence.exportsActive === 0).map((sample) => sample.software.eventLoopP99Ms);
  const exportLoop = ordered.filter((sample) => sample.evidence.exportDownloadActive || sample.evidence.exportsActive > 0).map((sample) => sample.software.eventLoopP99Ms);
  const slopeStart = Date.parse(first.serverGeneratedAt);
  const slopeSamples = ordered.filter((sample) => Date.parse(sample.serverGeneratedAt) >= slopeStart).map((sample) => ({ atMs: Date.parse(sample.serverGeneratedAt), value: sample.software.rssBytes }));
  const rssP99 = percentile(rss, 0.99);
  const rssMaximum = maximum(rss);
  const heapP99 = percentile(heap, 0.99);
  const heapMaximum = maximum(heap);
  const externalP99 = percentile(externalBuffers, 0.99);
  const externalMaximum = maximum(externalBuffers);
  const eventLoopNormalP99 = percentile(normalLoop, 0.99);
  const eventLoopExportP99 = percentile(exportLoop, 0.99);
  const eventLoopNormalMaximum = maximum(normalLoop);
  const eventLoopExportMaximum = maximum(exportLoop);
  const rssSlopeBytesPerHour = linearSlopePerHour(slopeSamples);
  const liveBandwidthMaximum = maximum(ordered.map((sample) => Math.max(sample.network.liveBytesPerSecond10s, sample.network.liveBytesPerSecond60s)));
  const applicationEgressMaximum = maximum(ordered.map((sample) => Math.max(sample.network.applicationBytesPerSecond10s, sample.network.applicationBytesPerSecond60s)));
  const writerItemsMaximum = maximum(ordered.map((sample) => sample.evidence.writerQueueItems));
  const writerBytesMaximum = maximum(ordered.map((sample) => sample.evidence.writerQueueBytes));
  const writerAgeMaximum = maximum(ordered.map((sample) => sample.evidence.writerOldestAgeMs));
  const clientQueuedBytesMaximum = maximum(ordered.map((sample) => sample.network.queuedBytes));
  if (rssP99 >= RSS_P99_LIMIT_BYTES) findings.push({ code: "rss-p99-limit", value: rssP99, limit: RSS_P99_LIMIT_BYTES });
  if (rssMaximum >= RSS_MAX_LIMIT_BYTES) findings.push({ code: "rss-maximum-limit", value: rssMaximum, limit: RSS_MAX_LIMIT_BYTES });
  if (heapP99 >= HEAP_P99_LIMIT_BYTES) findings.push({ code: "heap-p99-limit", value: heapP99, limit: HEAP_P99_LIMIT_BYTES });
  if (externalMaximum >= 128 * 1024 * 1024) findings.push({ code: "external-buffer-limit", value: externalMaximum, limit: 128 * 1024 * 1024 });
  if (maximum(hostCpu60) >= 85) findings.push({ code: "host-cpu-60s-limit", value: maximum(hostCpu60), limit: 85 });
  if (maximum(processCpu60) >= 70) findings.push({ code: "rf-monitor-cpu-60s-limit", value: maximum(processCpu60), limit: 70 });
  if (eventLoopNormalP99 === undefined || eventLoopNormalP99 >= 50) findings.push({ code: "event-loop-normal-p99-limit", value: eventLoopNormalP99, limit: 50 });
  if (eventLoopExportP99 === undefined || eventLoopExportP99 >= 100) findings.push({ code: "event-loop-export-p99-limit", value: eventLoopExportP99, limit: 100 });
  if (rssSlopeBytesPerHour === undefined || rssSlopeBytesPerHour > RSS_SLOPE_LIMIT_BYTES_PER_HOUR) findings.push({ code: "rss-v7-slope-limit", value: rssSlopeBytesPerHour, limit: RSS_SLOPE_LIMIT_BYTES_PER_HOUR });
  if (ordered.some((sample) => sample.network.dashboards > 8)) findings.push({ code: "dashboard-admission-limit" });
  if (liveBandwidthMaximum > LIVE_BANDWIDTH_LIMIT_BYTES_PER_SECOND) findings.push({ code: "live-bandwidth-limit", value: liveBandwidthMaximum, limit: LIVE_BANDWIDTH_LIMIT_BYTES_PER_SECOND });
  if (applicationEgressMaximum > APPLICATION_EGRESS_LIMIT_BYTES_PER_SECOND) findings.push({ code: "application-egress-limit", value: applicationEgressMaximum, limit: APPLICATION_EGRESS_LIMIT_BYTES_PER_SECOND });
  if (!ordered.some((sample) => sample.evidence.exportDownloadActive)) findings.push({ code: "export-download-not-observed" });
  if (!ordered.some((sample) => sample.network.dashboards === 8)) findings.push({ code: "eight-dashboard-load-not-observed" });
  if (maximum(ordered.map((sample) => sample.network.rejectedClients)) < 1) findings.push({ code: "ninth-dashboard-rejection-not-observed" });
  const loadStart = Date.parse(loadExercise.startedAt);
  const loadEnd = Date.parse(loadExercise.endedAt);
  const loadSamples = ordered.filter((sample) => {
    const at = Date.parse(sample.serverGeneratedAt);
    return at >= loadStart && at <= loadEnd;
  });
  if (!loadSamples.length || loadSamples.some((sample) => sample.network.dashboards !== 8)) findings.push({ code: "eight-dashboard-load-window-not-observed" });
  if (writerItemsMaximum >= WRITER_QUEUE_ITEMS_LIMIT) findings.push({ code: "writer-item-bound", value: writerItemsMaximum, limit: WRITER_QUEUE_ITEMS_LIMIT });
  if (writerBytesMaximum >= WRITER_QUEUE_BYTES_LIMIT) findings.push({ code: "writer-byte-bound", value: writerBytesMaximum, limit: WRITER_QUEUE_BYTES_LIMIT });
  if (writerAgeMaximum >= WRITER_AGE_LIMIT_MS) findings.push({ code: "writer-age-bound", value: writerAgeMaximum, limit: WRITER_AGE_LIMIT_MS });
  if (clientQueuedBytesMaximum >= CLIENT_QUEUE_TOTAL_LIMIT_BYTES) findings.push({ code: "client-queue-bound", value: clientQueuedBytesMaximum, limit: CLIENT_QUEUE_TOTAL_LIMIT_BYTES });
  if (ordered.some((sample) => sample.evidence.diskFreeBytes < sample.evidence.diskReserveBytes)) findings.push({ code: "disk-reserve-breached" });
  const applicationDrops = delta(first.network.applicationDrops, last.network.applicationDrops, "application-network-drops");
  if (applicationDrops !== 0) findings.push({ code: "application-network-drop", value: applicationDrops, limit: 0 });
  const firstInterfaces = new Map(first.network.interfaces.map((item) => [item.id, item]));
  for (const current of last.network.interfaces) {
    const start = firstInterfaces.get(current.id);
    if (!start) {
      findings.push({ code: "network-interface-changed", interfaceId: current.id });
      continue;
    }
    if (current.state !== "up" || start.state !== "up") findings.push({ code: "network-interface-not-up", interfaceId: current.id });
    for (const field of ["receiveErrors", "transmitErrors", "receiveDrops", "transmitDrops"]) {
      const change = delta(start[field], current[field], `network-${current.id}-${field}`);
      if (change !== 0) findings.push({ code: "network-counter-increase", interfaceId: current.id, field, value: change });
    }
  }
  if (last.network.interfaces.length !== first.network.interfaces.length) findings.push({ code: "network-interface-set-changed" });
  return {
    rssP99Bytes: rssP99,
    rssMaximumBytes: rssMaximum,
    heapP99Bytes: heapP99,
    heapMaximumBytes: heapMaximum,
    externalP99Bytes: externalP99,
    externalMaximumBytes: externalMaximum,
    eventLoopNormalP99Ms: eventLoopNormalP99,
    eventLoopExportP99Ms: eventLoopExportP99,
    eventLoopNormalMaximumMs: eventLoopNormalMaximum,
    eventLoopExportMaximumMs: eventLoopExportMaximum,
    hostCpu60sP99Percent: percentile(hostCpu60, 0.99),
    hostCpu60sMaximumPercent: maximum(hostCpu60),
    rfMonitorCpu60sP99Percent: percentile(processCpu60, 0.99),
    rfMonitorCpu60sMaximumPercent: maximum(processCpu60),
    rssSlopeBytesPerHour,
    liveBandwidthMaximumBytesPerSecond: liveBandwidthMaximum,
    applicationEgressMaximumBytesPerSecond: applicationEgressMaximum,
    writerQueueItemsMaximum: writerItemsMaximum,
    writerQueueBytesMaximum: writerBytesMaximum,
    writerAgeMaximumMs: writerAgeMaximum,
    clientQueuedBytesMaximum,
    applicationNetworkDrops: applicationDrops,
  };
}

export function analyzeLongQualification({ gate: gateInput, binding: bindingInput, samples, events = [], external = {} }) {
  const gateKey = String(gateInput).toLowerCase();
  const policy = GATE_POLICY[gateKey];
  assertion(policy, "qualification-gate-invalid");
  const binding = validateQualificationBinding(bindingInput);
  const witnessPublicKeyPem = external.witnessPublicKeyPem;
  assertion(typeof witnessPublicKeyPem === "string", "qualification-witness-public-key-required");
  let prerequisiteEvidence;
  let prerequisites;
  prerequisites = validateV7Prerequisites(external.prerequisites, binding, witnessPublicKeyPem);
  prerequisiteEvidence = { prerequisitesSha256: sha256(canonicalJson(prerequisites)) };
  assertion(Array.isArray(samples) && samples.length >= 2 && samples.length <= MAX_SAMPLES, "qualification-samples-invalid");
  const ordered = samples;
  for (let index = 0; index < ordered.length; index += 1) assertion(ordered[index].sequence === index + 1, "qualification-sample-sequence-gap");
  for (const sample of ordered) assertV7PhysicalSnapshot(sample);
  const findings = [];
  const first = ordered[0];
  const last = ordered.at(-1);
  const startedAtMs = Date.parse(first.serverGeneratedAt);
  const endedAtMs = Date.parse(last.serverGeneratedAt);
  const elapsedMs = endedAtMs - startedAtMs;
  if (elapsedMs < policy.minimumAcceptedElapsedMs) findings.push({ code: "minimum-elapsed-time-incomplete", value: elapsedMs, limit: policy.minimumAcceptedElapsedMs });
  if (elapsedMs > policy.maximumElapsedMs) findings.push({ code: "qualification-maximum-elapsed-exceeded", value: elapsedMs, limit: policy.maximumElapsedMs });
  for (let index = 1; index < ordered.length; index += 1) {
    try {
      assertQualificationSampleProgress(ordered[index - 1], ordered[index]);
    } catch (error) {
      findings.push({
        code: "sample-progress-contract-failed",
        at: ordered[index].serverGeneratedAt,
        detail: String(error instanceof Error ? error.message : error).slice(0, 256),
      });
    }
  }
  validateContinuity(ordered, findings);
  ensureStableIdentity(ordered, binding, findings);
  if (events.some((event) => event.severity === "blocking")) findings.push({ code: "blocking-collector-event", count: events.filter((event) => event.severity === "blocking").length });
  const unhealthy = ordered.filter((sample) => !sampleHealthy(sample));
  if (unhealthy.length) findings.push({ code: "unhealthy-samples", count: unhealthy.length, firstAt: unhealthy[0].serverGeneratedAt });
  const representativeHours = representativeHealthyHours(ordered);
  if (gateKey === "v7" && representativeHours.length < 24) findings.push({ code: "representative-healthy-hours-incomplete", value: representativeHours.length, limit: 24 });
  if (ordered.some((sample) => sample.schedule.optionalWorkAdmitted)) findings.push({ code: "optional-work-admitted" });
  if (ordered.some((sample) => sample.schedule.baselines.some((baseline) => baseline.lifecycle === "stale"))) findings.push({ code: "stale-baseline-observed" });
  if (ordered.some((sample) => sample.attribution.acceptedInvariantViolations !== 0)) findings.push({ code: "accepted-stale-attribution-invariant-violation" });
  const evidenceLoss = delta(first.continuity.evidenceFramesLost, last.continuity.evidenceFramesLost, "evidence-loss");
  if (evidenceLoss !== 0) findings.push({ code: "evidence-frame-loss", value: evidenceLoss, limit: 0 });
  const browserLoss = delta(first.continuity.browserFramesDropped, last.continuity.browserFramesDropped, "browser-loss");
  const targetResults = [];
  for (const expected of binding.tier1Targets) {
    const startTarget = first.schedule.targets.find((target) => target.targetId === expected.targetId);
    const endTarget = last.schedule.targets.find((target) => target.targetId === expected.targetId);
    if (!startTarget || !endTarget) {
      findings.push({ code: "target-timing-missing", targetId: expected.targetId });
      continue;
    }
    for (const field of ["validCompletions", "validRevisits", "objectiveMetRevisits", "objectiveMissedRevisits", "objectiveBreaches", "unknownVisits"]) {
      monotonicSeries(ordered, (sample) => sample.schedule.targets.find((target) => target.targetId === expected.targetId)?.[field] ?? -1, `target-${expected.targetId}-${field}`, findings);
    }
    const validRevisits = delta(startTarget.validRevisits, endTarget.validRevisits, `target-${expected.targetId}-valid-revisits`);
    const met = delta(startTarget.objectiveMetRevisits, endTarget.objectiveMetRevisits, `target-${expected.targetId}-objective-met`);
    const missed = delta(startTarget.objectiveMissedRevisits, endTarget.objectiveMissedRevisits, `target-${expected.targetId}-objective-missed`);
    const objectiveBreaches = delta(startTarget.objectiveBreaches, endTarget.objectiveBreaches, `target-${expected.targetId}-objective-breaches`);
    const unknown = delta(startTarget.unknownVisits, endTarget.unknownVisits, `target-${expected.targetId}-unknown-visits`);
    const ratio = validRevisits > 0 ? met / validRevisits : 0;
    if (validRevisits === 0 || ratio < 0.999) findings.push({ code: "target-revisit-objective-failed", targetId: expected.targetId, value: ratio, limit: 0.999 });
    if (met + missed !== validRevisits) findings.push({ code: "target-revisit-accounting-mismatch", targetId: expected.targetId });
    const missCauses = {};
    const unknownCauses = {};
    for (const cause of KNOWN_CAUSES) {
      const missDelta = delta(startTarget.missesByCause[cause] ?? 0, endTarget.missesByCause[cause] ?? 0, `target-${expected.targetId}-miss-${cause}`);
      const unknownDelta = delta(startTarget.unknownsByCause[cause] ?? 0, endTarget.unknownsByCause[cause] ?? 0, `target-${expected.targetId}-unknown-${cause}`);
      if (missDelta) missCauses[cause] = missDelta;
      if (unknownDelta) unknownCauses[cause] = unknownDelta;
    }
    const baseline = last.schedule.baselines.find((item) => item.targetId === expected.targetId);
    if (gateKey === "v7" && (!baseline || !["reviewable", "protected"].includes(baseline.lifecycle) || baseline.representativeHours < 24)) {
      findings.push({ code: "target-baseline-not-reviewable", targetId: expected.targetId });
    }
    targetResults.push({
      targetId: expected.targetId,
      objectiveMs: expected.objectiveMs,
      validRevisits,
      objectiveMetRevisits: met,
      objectiveMissedRevisits: missed,
      objectiveBreaches,
      onTimeRatio: ratio,
      unknownVisits: unknown,
      missCauses,
      unknownCauses,
      revisitHistogram: histogramDelta(startTarget.revisitHistogram, endTarget.revisitHistogram, `target-${expected.targetId}-revisit-histogram`),
      unobservedGapHistogram: histogramDelta(startTarget.unobservedGapHistogram, endTarget.unobservedGapHistogram, `target-${expected.targetId}-gap-histogram`),
      revisitDistribution: endTarget.revisitMs,
      unobservedGapDistribution: endTarget.unobservedGapMs,
      baseline: baseline ?? null,
    });
  }

  let resourceMetrics;
  let externalEvidence;
  let faultMatrix;
  let switchCounters;
  let backupRestore;
  let loadExercise;
  faultMatrix = validateV7FaultRecoveryMatrix(external.faultMatrix, binding, witnessPublicKeyPem);
  assertion(Date.parse(faultMatrix.completedAt) <= startedAtMs, "v7-fault-matrix-must-precede-run");
  backupRestore = validateV7BackupRestore(external.backupRestore, binding, witnessPublicKeyPem, startedAtMs, faultMatrix);
  switchCounters = validateV7SwitchCounters(external.switchCounters, binding, witnessPublicKeyPem, startedAtMs, endedAtMs);
  loadExercise = validateV7LoadExercise(external.loadExercise, binding, witnessPublicKeyPem, startedAtMs, endedAtMs);
  resourceMetrics = analyzeResourceAcceptance(ordered, findings, loadExercise);
  if (browserLoss !== 0) findings.push({ code: "browser-delivery-loss", value: browserLoss, limit: 0 });
  externalEvidence = {
    faultRecoveryMatrixSha256: sha256(canonicalJson(faultMatrix)),
    switchCountersSha256: sha256(canonicalJson(switchCounters)),
    backupRestoreSha256: sha256(canonicalJson(backupRestore)),
    loadExerciseSha256: sha256(canonicalJson(loadExercise)),
  };

  const readinessOnly = findings.every((finding) => ["minimum-elapsed-time-incomplete", "representative-healthy-hours-incomplete"].includes(finding.code));
  const result = findings.length === 0 ? "PASS" : readinessOnly ? "NOT_READY" : "FAIL";
  return {
    schemaVersion: 1,
    kind: "rf-monitor-long-qualification-result",
    gate: policy.gate,
    result,
    candidateId: binding.candidateId,
    identityDigest: identityDigest(binding),
    startedAt: first.serverGeneratedAt,
    endedAt: last.serverGeneratedAt,
    elapsedMs,
    requiredElapsedMs: policy.requiredElapsedMs,
    samples: ordered.length,
    serviceBootId: first.serviceBootId,
    commissioningEpochId: first.commissioningEpochId,
    representativeHealthyHours: representativeHours,
    continuity: {
      blockingEvents: events.filter((event) => event.severity === "blocking").length,
      evidenceFramesLost: evidenceLoss,
      browserFramesDropped: browserLoss,
      acceptedStaleAttributionInvariantViolations: maximum(ordered.map((sample) => sample.attribution.acceptedInvariantViolations)),
      rejectedOrInvalidFramesObserved: delta(first.attribution.rejectedEpochFrames, last.attribution.rejectedEpochFrames, "rejected-or-invalid-frames"),
    },
    targets: targetResults,
    ...(resourceMetrics ? { resourceMetrics } : {}),
    ...(externalEvidence ? { externalEvidence } : {}),
    prerequisiteEvidence,
    findings,
    limitations: [
      "This gate qualifies only the exact bound release, configuration, catalog, detector, site, receiver model, and receiver identity.",
      "Rejected stale or invalid frames are not accepted attribution; opaque FFT contents cannot independently identify their hardware tune frequency.",
      "A PASS does not identify spoofing, deliberate jamming, navigation error, or intent.",
    ],
  };
}

export function buildLongQualificationFailure({ gate: gateInput, binding: bindingInput, samples = [], events = [], error }) {
  const gateKey = String(gateInput).toLowerCase();
  const policy = GATE_POLICY[gateKey];
  assertion(policy, "qualification-gate-invalid");
  const binding = validateQualificationBinding(bindingInput);
  const first = samples[0];
  const last = samples.at(-1);
  const startedAt = first?.serverGeneratedAt ?? new Date().toISOString();
  const endedAt = last?.serverGeneratedAt ?? startedAt;
  return {
    schemaVersion: 1,
    kind: "rf-monitor-long-qualification-result",
    gate: policy.gate,
    result: "FAIL",
    candidateId: binding.candidateId,
    identityDigest: identityDigest(binding),
    startedAt,
    endedAt,
    elapsedMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    requiredElapsedMs: policy.requiredElapsedMs,
    samples: samples.length,
    serviceBootId: first?.serviceBootId ?? "not-observed",
    commissioningEpochId: first?.commissioningEpochId ?? "not-observed",
    representativeHealthyHours: [],
    continuity: {
      blockingEvents: events.filter((event) => event.severity === "blocking").length,
      evidenceFramesLost: undefined,
      browserFramesDropped: undefined,
      acceptedStaleAttributionInvariantViolations: undefined,
      rejectedOrInvalidFramesObserved: undefined,
    },
    targets: binding.tier1Targets.map((target) => ({ targetId: target.targetId, objectiveMs: target.objectiveMs, result: "not-evaluated" })),
    findings: [{ code: "qualification-analysis-or-external-evidence-failed", detail: String(error instanceof Error ? error.message : error).slice(0, 512) }],
    limitations: [
      "The gate failed closed before all acceptance criteria could be evaluated.",
      "Raw append-only samples and any installed custody inputs are preserved for review.",
      "No spoofing, deliberate-jamming, navigation-integrity, or intent claim is made.",
    ],
  };
}

function pathWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoSymlinks(absolutePath, allowMissingFinal = false) {
  assertion(path.isAbsolute(absolutePath), "qualification-path-must-be-absolute");
  const resolved = path.resolve(absolutePath);
  assertion(resolved !== path.parse(resolved).root, "qualification-filesystem-root-refused");
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      const details = await lstat(current);
      assertion(!details.isSymbolicLink(), `qualification-symlink-refused:${current}`);
      if (index < segments.length - 1) assertion(details.isDirectory(), `qualification-path-component-not-directory:${current}`);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingFinal && index === segments.length - 1) return;
      throw error;
    }
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeNoReplace(filePath, value, mode = 0o600) {
  const contents = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  const temporary = `${filePath}.${randomUUID()}.partial`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeAtomicCheckpoint(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.partial`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function readBoundedJson(filePath, maximumBytes = 1024 * 1024) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    assertion(details.isFile() && details.size <= maximumBytes, `qualification-json-invalid:${filePath}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function sha256FileNoFollow(filePath, maximumBytes = 512 * 1024 * 1024) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const details = await handle.stat();
    assertion(details.isFile() && details.size <= maximumBytes, `qualification-evidence-file-bound:${filePath}`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      assertion(bytes <= maximumBytes, `qualification-evidence-file-bound:${filePath}`);
      hash.update(chunk);
    }
  } finally { await handle.close(); }
  return { sha256: hash.digest("hex"), bytes };
}

export async function hashQualificationInput(filePath, maximumBytes = 16 * 1024 * 1024) {
  assertion(path.isAbsolute(filePath), "qualification-input-path-must-be-absolute");
  await assertNoSymlinks(filePath);
  return sha256FileNoFollow(filePath, maximumBytes);
}

async function copyFileNoFollow(sourcePath, destinationPath, expectedSha256, maximumBytes = 512 * 1024 * 1024) {
  const source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const destination = await open(destinationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o400);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const details = await source.stat();
    assertion(details.isFile() && details.size <= maximumBytes, `qualification-evidence-file-bound:${sourcePath}`);
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      assertion(bytes <= maximumBytes, `qualification-evidence-file-bound:${sourcePath}`);
      hash.update(chunk);
      await destination.write(chunk);
    }
    await destination.sync();
  } finally {
    await source.close();
    await destination.close();
  }
  const actual = hash.digest("hex");
  assertion(actual === expectedSha256, `qualification-evidence-hash-mismatch:${sourcePath}`);
  return { sha256: actual, bytes };
}

export class QualificationRunStore {
  constructor(runDirectory) {
    this.runDirectory = path.resolve(runDirectory);
    this.samplesDirectory = path.join(this.runDirectory, "samples");
    this.eventsDirectory = path.join(this.runDirectory, "events");
  }

  async initialize({ gate, binding }) {
    assertion(GATE_POLICY[gate], "qualification-gate-invalid");
    await assertNoSymlinks(path.dirname(this.runDirectory));
    await mkdir(this.runDirectory, { mode: 0o700 });
    await mkdir(this.samplesDirectory, { mode: 0o700 });
    await mkdir(this.eventsDirectory, { mode: 0o700 });
    const validated = validateQualificationBinding(binding);
    await writeNoReplace(path.join(this.runDirectory, "binding.json"), validated);
    await writeNoReplace(path.join(this.runDirectory, "run.json"), {
      schemaVersion: 1,
      kind: "rf-monitor-long-qualification-run",
      gate: GATE_POLICY[gate].gate,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      identityDigest: identityDigest(validated),
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      minimumElapsedMs: GATE_POLICY[gate].requiredElapsedMs,
      status: "initialized",
    });
    await writeAtomicCheckpoint(path.join(this.runDirectory, "checkpoint.json"), { schemaVersion: 1, samples: 0, events: 0, status: "initialized", updatedAt: new Date().toISOString() });
    return this.load();
  }

  async load() {
    await assertNoSymlinks(this.runDirectory);
    const run = await readBoundedJson(path.join(this.runDirectory, "run.json"));
    const binding = validateQualificationBinding(await readBoundedJson(path.join(this.runDirectory, "binding.json")));
    assertion(run.identityDigest === identityDigest(binding), "qualification-run-binding-digest-mismatch");
    return { run, binding, checkpoint: await readBoundedJson(path.join(this.runDirectory, "checkpoint.json")) };
  }

  async readSamples() {
    await assertNoSymlinks(this.samplesDirectory);
    const memoryBefore = process.memoryUsage();
    const maxRssBeforeBytes = process.resourceUsage().maxRSS * 1024;
    const entries = (await readdir(this.samplesDirectory)).filter((entry) => /^samples-[A-Za-z0-9._+-]+\.jsonl(?:\.partial)?$/.test(entry)).sort();
    const samples = [];
    const recoveryEvents = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const filePath = path.join(this.samplesDirectory, entry);
      assertion(pathWithin(this.samplesDirectory, filePath), "qualification-sample-path-escape");
      const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let contents;
      try {
        const details = await handle.stat();
        assertion(details.isFile() && details.size <= CHUNK_MAX_BYTES + RECORD_MAX_BYTES, "qualification-sample-chunk-bound");
        totalBytes += details.size;
        assertion(totalBytes <= MAX_TOTAL_SAMPLE_BYTES, "qualification-total-sample-bound");
        contents = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const partial = entry.endsWith(".partial");
      const terminated = contents.endsWith("\n");
      const lines = contents.split("\n");
      if (!terminated) lines.pop();
      for (const line of lines) if (line) {
        const value = JSON.parse(line);
        assertion(Buffer.byteLength(line) <= RECORD_MAX_BYTES, "qualification-sample-record-bound");
        samples.push(value);
        assertion(samples.length <= MAX_SAMPLES, "qualification-sample-count-bound");
      }
      if (partial) recoveryEvents.push({ schemaVersion: 1, type: "collector-partial-sample-chunk", severity: "blocking", at: new Date().toISOString(), file: entry });
      if (!terminated) recoveryEvents.push({ schemaVersion: 1, type: "collector-torn-sample-tail", severity: "blocking", at: new Date().toISOString(), file: entry });
    }
    assertion(samples.length <= MAX_SAMPLES, "qualification-sample-count-bound");
    samples.sort((left, right) => left.sequence - right.sequence);
    const memoryAfter = process.memoryUsage();
    return {
      samples,
      recoveryEvents,
      inputBytes: totalBytes,
      analyzerMemory: {
        rssBeforeReadBytes: memoryBefore.rss,
        rssAfterReadBytes: memoryAfter.rss,
        heapUsedBeforeReadBytes: memoryBefore.heapUsed,
        heapUsedAfterReadBytes: memoryAfter.heapUsed,
        processMaxRssBeforeReadBytes: maxRssBeforeBytes,
        processMaxRssAfterReadBytes: process.resourceUsage().maxRSS * 1024,
      },
    };
  }

  async readSampleSummary() {
    await assertNoSymlinks(this.samplesDirectory);
    const entries = (await readdir(this.samplesDirectory)).filter((entry) => /^samples-[A-Za-z0-9._+-]+\.jsonl(?:\.partial)?$/.test(entry)).sort();
    let first;
    let last;
    let samples = 0;
    let expectedSequence = 1;
    const recoveryEvents = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const filePath = path.join(this.samplesDirectory, entry);
      const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let contents;
      try {
        const details = await handle.stat();
        assertion(details.isFile() && details.size <= CHUNK_MAX_BYTES + RECORD_MAX_BYTES, "qualification-sample-chunk-bound");
        totalBytes += details.size;
        assertion(totalBytes <= MAX_TOTAL_SAMPLE_BYTES, "qualification-total-sample-bound");
        contents = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const partial = entry.endsWith(".partial");
      const terminated = contents.endsWith("\n");
      const lines = contents.split("\n");
      if (!terminated) lines.pop();
      for (const line of lines) if (line) {
        assertion(Buffer.byteLength(line) <= RECORD_MAX_BYTES, "qualification-sample-record-bound");
        const sample = JSON.parse(line);
        assertion(sample.sequence === expectedSequence, "qualification-sample-sequence-gap");
        first ??= sample;
        last = sample;
        samples += 1;
        assertion(samples <= MAX_SAMPLES, "qualification-sample-count-bound");
        expectedSequence += 1;
      }
      if (partial) recoveryEvents.push({ schemaVersion: 1, type: "collector-partial-sample-chunk", severity: "blocking", at: new Date().toISOString(), file: entry });
      if (!terminated) recoveryEvents.push({ schemaVersion: 1, type: "collector-torn-sample-tail", severity: "blocking", at: new Date().toISOString(), file: entry });
    }
    assertion(samples <= MAX_SAMPLES, "qualification-sample-count-bound");
    return { first, last, samples, recoveryEvents, inputBytes: totalBytes };
  }

  async readEvents() {
    await assertNoSymlinks(this.eventsDirectory);
    const entries = (await readdir(this.eventsDirectory)).filter((entry) => /^events-[A-Za-z0-9._+-]+\.jsonl(?:\.partial)?$/.test(entry)).sort();
    const events = [];
    for (const entry of entries) {
      const handle = await open(path.join(this.eventsDirectory, entry), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let contents;
      try {
        const details = await handle.stat();
        assertion(details.isFile() && details.size <= CHUNK_MAX_BYTES, "qualification-event-chunk-bound");
        contents = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const partial = entry.endsWith(".partial");
      const terminated = contents.endsWith("\n");
      const lines = contents.split("\n");
      if (!terminated) lines.pop();
      for (const line of lines) if (line) {
        assertion(Buffer.byteLength(line) <= EVENT_MAX_BYTES, "qualification-event-record-bound");
        events.push(JSON.parse(line));
      }
      if (partial) events.push({ schemaVersion: 1, type: "collector-partial-event-chunk", severity: "blocking", at: new Date().toISOString(), file: entry });
      if (!terminated) events.push({ schemaVersion: 1, type: "collector-torn-event-tail", severity: "blocking", at: new Date().toISOString(), file: entry });
    }
    assertion(events.length <= MAX_EVENT_RECORDS, "qualification-event-count-bound");
    return events;
  }

  async createAppender(kind) {
    assertion(["samples", "events"].includes(kind), "qualification-appender-kind-invalid");
    const directory = kind === "samples" ? this.samplesDirectory : this.eventsDirectory;
    const prefix = kind === "samples" ? "samples" : "events";
    const partialPath = path.join(directory, `${prefix}-${Date.now()}-${randomUUID()}.jsonl.partial`);
    const finalPath = partialPath.slice(0, -".partial".length);
    const handle = await open(partialPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    return {
      append: async (value) => {
        const line = `${JSON.stringify(value)}\n`;
        const bound = kind === "samples" ? RECORD_MAX_BYTES : EVENT_MAX_BYTES;
        assertion(Buffer.byteLength(line) <= bound, `qualification-${kind}-record-bound`);
        assertion(bytes + Buffer.byteLength(line) <= CHUNK_MAX_BYTES, `qualification-${kind}-chunk-full`);
        await handle.write(line);
        await handle.sync();
        bytes += Buffer.byteLength(line);
      },
      bytes: () => bytes,
      close: async () => {
        await handle.sync();
        await handle.close();
        await rename(partialPath, finalPath);
        await fsyncDirectory(directory);
        return finalPath;
      },
    };
  }

  async checkpoint(value) {
    await writeAtomicCheckpoint(path.join(this.runDirectory, "checkpoint.json"), { schemaVersion: 1, ...value, updatedAt: new Date().toISOString() });
  }

  async installInput(name, value) {
    assertion(/^[a-z][a-z0-9-]{0,63}$/.test(name), "qualification-input-name-invalid");
    const filePath = path.join(this.runDirectory, `${name}.input.json`);
    await writeNoReplace(filePath, value);
    return filePath;
  }

  async loadInstalledInput(name) {
    assertion(/^[a-z][a-z0-9-]{0,63}$/.test(name), "qualification-input-name-invalid");
    return readBoundedJson(path.join(this.runDirectory, `${name}.input.json`));
  }

  async installCustody(name, record, evidenceRoot) {
    assertion(/^[a-z][a-z0-9-]{0,63}$/.test(name), "qualification-custody-name-invalid");
    assertion(path.isAbsolute(evidenceRoot), "qualification-evidence-root-must-be-absolute");
    const resolvedRoot = path.resolve(evidenceRoot);
    await assertNoSymlinks(resolvedRoot);
    const custodyRoot = path.join(this.runDirectory, "custody");
    await mkdir(custodyRoot, { mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
    await assertNoSymlinks(custodyRoot);
    const directory = path.join(custodyRoot, name);
    await mkdir(directory, { mode: 0o700 });
    await writeNoReplace(path.join(directory, "record.json"), record, 0o400);
    const filesDirectory = path.join(directory, "files");
    await mkdir(filesDirectory, { mode: 0o700 });
    let totalBytes = 0;
    const files = [];
    const entries = validateEvidenceFileManifest(record, `custody-${name}`);
    for (const [index, entry] of entries.entries()) {
      const sourcePath = path.resolve(resolvedRoot, ...entry.path.split("/"));
      assertion(pathWithin(resolvedRoot, sourcePath) && sourcePath !== resolvedRoot, `qualification-evidence-path-escape:${entry.path}`);
      await assertNoSymlinks(sourcePath);
      const storedPath = path.join(filesDirectory, String(index).padStart(4, "0"));
      const copied = await copyFileNoFollow(sourcePath, storedPath, entry.sha256);
      totalBytes += copied.bytes;
      assertion(totalBytes <= 4 * 1024 * 1024 * 1024, "qualification-custody-total-bound");
      files.push({ sourcePath: entry.path, storedPath: `files/${String(index).padStart(4, "0")}`, ...copied });
    }
    const manifest = {
      schemaVersion: 1,
      name,
      installedAt: new Date().toISOString(),
      recordSha256: sha256(canonicalJson(record)),
      files,
      totalBytes,
    };
    manifest.custodySha256 = sha256(canonicalJson(manifest));
    await writeNoReplace(path.join(directory, "custody.json"), manifest, 0o400);
    await fsyncDirectory(filesDirectory);
    await fsyncDirectory(directory);
    return manifest;
  }

  async verifyCustody(name, record) {
    assertion(/^[a-z][a-z0-9-]{0,63}$/.test(name), "qualification-custody-name-invalid");
    const directory = path.join(this.runDirectory, "custody", name);
    await assertNoSymlinks(directory);
    const manifest = await readBoundedJson(path.join(directory, "custody.json"));
    assertion(manifest.recordSha256 === sha256(canonicalJson(record)), `qualification-custody-record-mismatch:${name}`);
    let totalBytes = 0;
    for (const file of manifest.files ?? []) {
      const filePath = path.resolve(directory, ...String(file.storedPath).split("/"));
      assertion(pathWithin(directory, filePath), `qualification-custody-path-escape:${name}`);
      const verified = await sha256FileNoFollow(filePath);
      assertion(verified.sha256 === file.sha256 && verified.bytes === file.bytes, `qualification-custody-file-mismatch:${name}`);
      totalBytes += verified.bytes;
    }
    assertion(totalBytes === manifest.totalBytes, `qualification-custody-size-mismatch:${name}`);
    const { custodySha256, ...unsigned } = manifest;
    assertion(custodySha256 === sha256(canonicalJson(unsigned)), `qualification-custody-manifest-mismatch:${name}`);
    return manifest;
  }

  async installArtifact(name, sourcePath, maximumBytes = 64 * 1024 * 1024) {
    assertion(/^[a-z][a-z0-9-]{0,63}$/.test(name), "qualification-artifact-name-invalid");
    assertion(path.isAbsolute(sourcePath), "qualification-artifact-path-must-be-absolute");
    await assertNoSymlinks(sourcePath);
    const directory = path.join(this.runDirectory, "artifacts");
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
    const destination = path.join(directory, name);
    const expected = await sha256FileNoFollow(sourcePath, maximumBytes);
    await copyFileNoFollow(sourcePath, destination, expected.sha256, maximumBytes);
    const descriptor = { schemaVersion: 1, name, sourceSha256: expected.sha256, bytes: expected.bytes, storedPath: `artifacts/${name}` };
    await writeNoReplace(path.join(directory, `${name}.json`), descriptor, 0o400);
    return descriptor;
  }

  async verifyArtifact(name) {
    const descriptor = await readBoundedJson(path.join(this.runDirectory, "artifacts", `${name}.json`));
    const verified = await sha256FileNoFollow(path.join(this.runDirectory, descriptor.storedPath), 64 * 1024 * 1024);
    assertion(verified.sha256 === descriptor.sourceSha256 && verified.bytes === descriptor.bytes, `qualification-artifact-mismatch:${name}`);
    return descriptor;
  }

  async readArtifact(name, encoding) {
    const descriptor = await this.verifyArtifact(name);
    const handle = await open(path.join(this.runDirectory, descriptor.storedPath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { return await handle.readFile(encoding); } finally { await handle.close(); }
  }

  async finalize(result, externalRecords = {}) {
    assertion(result.result === "PASS" || result.result === "FAIL", "qualification-not-finalizable");
    const output = { ...result, finalizedAt: new Date().toISOString(), sampleFiles: [], eventFiles: [], inputFiles: [], custodyFiles: [], externalFiles: {} };
    const files = [];
    for (const directory of [this.samplesDirectory, this.eventsDirectory]) {
      for (const entry of (await readdir(directory)).filter((name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.partial")).sort()) {
        const relative = path.relative(this.runDirectory, path.join(directory, entry)).replaceAll("\\", "/");
        const hashed = await sha256FileNoFollow(path.join(directory, entry), CHUNK_MAX_BYTES);
        const descriptor = { path: relative, ...hashed };
        files.push(descriptor);
        if (directory === this.samplesDirectory) output.sampleFiles.push(descriptor); else output.eventFiles.push(descriptor);
      }
    }
    for (const [name, value] of Object.entries(externalRecords)) {
      const externalPath = path.join(this.runDirectory, `${name}.json`);
      await writeNoReplace(externalPath, value);
      const hashed = await sha256FileNoFollow(externalPath, 16 * 1024 * 1024);
      output.externalFiles[name] = { path: `${name}.json`, ...hashed };
      files.push(output.externalFiles[name]);
    }
    for (const entry of (await readdir(this.runDirectory)).filter((name) => name.endsWith(".input.json")).sort()) {
      const inputPath = path.join(this.runDirectory, entry);
      const hashed = await sha256FileNoFollow(inputPath, 16 * 1024 * 1024);
      const descriptor = { path: entry, ...hashed };
      output.inputFiles.push(descriptor);
      files.push(descriptor);
    }
    const captureTree = async (root, relativeRoot) => {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(root, entry.name);
        const relative = `${relativeRoot}/${entry.name}`;
        const details = await lstat(absolute);
        assertion(!details.isSymbolicLink(), `qualification-finalize-symlink-refused:${relative}`);
        if (details.isDirectory()) await captureTree(absolute, relative);
        else {
          assertion(details.isFile(), `qualification-finalize-entry-invalid:${relative}`);
          const hashed = await sha256FileNoFollow(absolute);
          const descriptor = { path: relative, ...hashed };
          output.custodyFiles.push(descriptor);
          files.push(descriptor);
        }
      }
    };
    await captureTree(path.join(this.runDirectory, "custody"), "custody");
    await captureTree(path.join(this.runDirectory, "artifacts"), "artifacts");
    output.artifactSetSha256 = sha256(canonicalJson(files));
    const resultPath = path.join(this.runDirectory, "qualification.json");
    await writeNoReplace(resultPath, output, 0o440);
    const qualificationHash = await sha256FileNoFollow(resultPath, 16 * 1024 * 1024);
    await writeNoReplace(path.join(this.runDirectory, "SHA256SUMS.txt"), `${qualificationHash.sha256}  qualification.json\n`, 0o440);
    await chmod(resultPath, 0o440);
    await this.checkpoint({ samples: result.samples, events: result.continuity.blockingEvents, status: result.result === "PASS" ? "passed" : "failed", finalized: true });
    return resultPath;
  }
}

export async function loadJsonInput(filePath) {
  assertion(path.isAbsolute(filePath), "qualification-input-path-must-be-absolute");
  await assertNoSymlinks(filePath);
  return readBoundedJson(filePath);
}

export function collectorBootIdentity() {
  return randomUUID();
}
