import { randomUUID } from "node:crypto";
import {
  DEFAULT_THRESHOLDS,
  DetectionEngine,
  aggregateVisitFrames,
  createBaselineFingerprint,
  detectionRuleFingerprint,
  type DetectionThresholds,
} from "../shared/detection";
import type {
  BandCatalog,
  BandPreset,
  DetectionKind,
  PhysicalCaptureTarget,
  SpectrumFrame,
  TargetObservation,
} from "../shared/types";
import type {
  SyntheticExpectedOutcome,
  SyntheticArtifactInputs,
  SyntheticRunMetadata,
  SyntheticRunMode,
  SyntheticRunProvenance,
  SyntheticRunScore,
  SyntheticScenarioDefinition,
  ValidationObservationWindow,
  ValidationObservedAlert,
} from "../shared/syntheticValidation";
import {
  SyntheticValidationRun,
  createResearchSyntheticScenarioSuite,
  sha256Canonical,
  verifySyntheticTruthDisclosure,
} from "./syntheticValidation";
import { detectorQualificationPlan } from "../shared/detectorQualification";

export const SYNTHETIC_QUALIFICATION_REPORT_VERSION = 1 as const;

const TARGET_ID = "gnss-l1-e1-b1c-sbas";
const BIN_COUNT = 512;
const ANALYSIS_START_BIN = 51;
const ANALYSIS_END_BIN = 461;
const VISIT_INTERVAL_MS = 1_000;
const RAW_FRAME_INTERVAL_MS = 250;
const FRAMES_PER_VISIT = 3;
const TRAINING_OBSERVATIONS = 64;
const FIXED_EPOCH_MS = Date.parse("2026-01-01T00:00:00.000Z");
const SCENARIO_NAMES: Record<string, string> = {
  sham: "Normal signal",
  wideband: "Wideband rise",
  "pulsed-wideband": "Pulsed wideband",
  cw: "Single tone",
  multitone: "Multiple tones",
  "moving-narrowband": "Moving narrowband",
  overload: "Receiver overload",
  "configuration-change": "Configuration change",
  "data-gap": "Data gap",
  "matched-power-spoofing": "Matched-power control",
};

export interface SyntheticScenarioSummary {
  id: string;
  name: string;
  version: string;
  durationMs: number;
  expectedOutcome: SyntheticExpectedOutcome;
  target: {
    id: string;
    label: string;
    centerHz: number;
  };
}

export interface SyntheticQualificationReport {
  schemaVersion: typeof SYNTHETIC_QUALIFICATION_REPORT_VERSION;
  synthetic: true;
  source: "isolated-simulation";
  qualification: {
    planVersion: string;
    planHash: string;
    level: "isolated-deterministic" | "isolated-randomized";
    installedChain: "not-run";
  };
  runId: string;
  mode: SyntheticRunMode;
  scenario: SyntheticScenarioSummary;
  detector: {
    implementation: "DetectionEngine";
    ruleSetId: string;
    trainingObservations: number;
    visitIntervalMs: number;
    framesPerVisit: number;
  };
  provenance: SyntheticRunProvenance;
  truth: {
    commitment: string;
    disclosedAfterRun: boolean;
    verified: boolean;
  };
  observed: {
    outcome: "alert" | "no-alert" | "unknown";
    alertKinds: DetectionKind[];
    validObservations: number;
    unknownObservations: number;
    receiverOverload: boolean;
    rfAnomalyAlert: boolean;
  };
  score: SyntheticRunScore;
  passed: boolean;
}

export interface SyntheticQualificationRunnerOptions {
  thresholds?: DetectionThresholds;
  seedPrefix?: string;
  softwareBuild?: unknown;
  configuration?: unknown;
  /** Active validated catalog; qualification targets may not be duplicated here. */
  bandCatalog?: BandCatalog;
  /** Stable campaign run identity. Ad-hoc UI runs leave this unset. */
  runId?: string;
  /** A campaign must bind detector execution to its pre-run commitment. */
  expectedTruthCommitment?: string;
  qualificationLevel?: "isolated-deterministic" | "isolated-randomized";
}

export interface PreparedSyntheticQualificationRun {
  runId: string;
  targetId: string;
  ruleSetHash: string;
  metadata: SyntheticRunMetadata;
  provenance: SyntheticRunProvenance;
}

function scenarioSuite(seedPrefix: string, targetId = TARGET_ID): SyntheticScenarioDefinition[] {
  return createResearchSyntheticScenarioSuite({
    seedPrefix,
    target: {
      id: targetId,
      binCount: BIN_COUNT,
      baselineLevel: 32,
      noiseAmplitudeBins: 2,
      rippleAmplitudeBins: 2,
    },
  });
}

export function listSyntheticQualificationScenarios(
  catalog: BandCatalog,
  seedPrefix = "rf-monitor-qualification-v1",
): SyntheticScenarioSummary[] {
  const band = validationBand(TARGET_ID, catalog);
  return scenarioSuite(seedPrefix, TARGET_ID).map((scenario) => ({
    id: scenario.id,
    name: SCENARIO_NAMES[scenario.id] ?? scenario.name,
    version: scenario.version,
    durationMs: scenario.durationMs,
    expectedOutcome: scenario.events[0]?.expected.outcome ?? "unknown",
    target: {
      id: TARGET_ID,
      label: band.label,
      centerHz: band.centerHz,
    },
  }));
}

function validationBand(targetId: string, catalog: BandCatalog): BandPreset {
  const target = catalog.captureTargets.find((candidate) => candidate.id === targetId);
  if (!target || target.service !== "gnss") throw new Error(`Qualification target ${targetId} is absent from catalog ${catalog.catalogVersion}`);
  const primaryBandId = target.relatedBandIds[0];
  return {
    id: primaryBandId,
    label: target.label,
    service: "gnss",
    startHz: target.centerHz - target.analysisSpanHz / 2,
    endHz: target.centerHz + target.analysisSpanHz / 2,
    centerHz: target.centerHz,
    captureTargetId: targetId,
    captureCenterHz: target.centerHz,
    captureSpanHz: target.captureSpanHz,
    analysisSpanHz: target.analysisSpanHz,
    priority: 1,
    dwellMs: VISIT_INTERVAL_MS,
    editable: false,
  };
}

function qualificationTarget(targetId: string, catalog: BandCatalog): PhysicalCaptureTarget {
  const target = catalog.captureTargets.find((candidate) => candidate.id === targetId);
  if (!target || target.service !== "gnss") throw new Error(`Qualification target ${targetId} is absent from catalog ${catalog.catalogVersion}`);
  if (!detectorQualificationPlan(catalog).targets.some((candidate) => candidate.id === targetId)) {
    throw new Error(`Qualification target ${targetId} is not a default Tier-1 target`);
  }
  return target;
}

function fingerprint(
  target: PhysicalCaptureTarget,
  catalogVersion: string,
  configurationOffset: number,
  detectionRuleHash: string,
) {
  return createBaselineFingerprint({
    dataDomain: "test",
    receiverIdentity: "synthetic:qualification-receiver-0",
    receiverKey: "synthetic-receiver-0",
    deviceName: "Synthetic FFT source",
    sdrconnectVersion: "not-used",
    activeAntenna: "synthetic",
    gainProfileId: `synthetic-fixed-${configurationOffset}`,
    targetId: target.id,
    centerHz: target.centerHz,
    sampleRateHz: 10_000_000,
    inputBinCount: BIN_COUNT,
    analysisStartBin: ANALYSIS_START_BIN,
    analysisEndBin: ANALYSIS_END_BIN,
    analysisMaskHash: `synthetic-center-${target.analysisSpanHz}-of-${target.captureSpanHz}hz`,
    spectrumReference: 0,
    spectrumBase: 0,
    catalogVersion,
    detectionRuleHash,
  });
}

function analysisBins(input: Uint8Array): Uint8Array {
  return input.slice(ANALYSIS_START_BIN, ANALYSIS_END_BIN);
}

function directObservation(input: {
  bins: Uint8Array;
  target: PhysicalCaptureTarget;
  catalogVersion: string;
  bandId: string;
  sequence: number;
  observedMonotonicMs: number;
  configurationOffset: number;
  overload: boolean;
  detectionRuleHash: string;
}): TargetObservation {
  const observedAtMs = FIXED_EPOCH_MS + input.observedMonotonicMs;
  const baselineFingerprint = fingerprint(input.target, input.catalogVersion, input.configurationOffset, input.detectionRuleHash);
  return {
    dataDomain: "test",
    id: `synthetic-training-${input.sequence}`,
    visitId: `synthetic-training-visit-${input.sequence}`,
    configurationEpoch: input.configurationOffset + 1,
    tuneEpoch: input.sequence + 1,
    visitEpoch: input.sequence + 1,
    targetId: input.target.id,
    receiver: 0,
    bandId: input.bandId,
    affectedBandIds: [...input.target.relatedBandIds],
    observedAt: new Date(observedAtMs).toISOString(),
    firstFrameAt: new Date(observedAtMs - 500).toISOString(),
    lastFrameAt: new Date(observedAtMs).toISOString(),
    exposureMs: 500,
    acceptedFrameCount: FRAMES_PER_VISIT,
    bins: analysisBins(input.bins),
    confirmedCenterHz: baselineFingerprint.centerHz,
    confirmedSampleRateHz: baselineFingerprint.sampleRateHz,
    tuneConfirmedAt: new Date(observedAtMs - 750).toISOString(),
    fingerprint: baselineFingerprint,
    overload: input.overload,
    healthComplete: true,
  };
}

function visitFrames(input: {
  validationRun: SyntheticValidationRun;
  target: PhysicalCaptureTarget;
  bandId: string;
  completionMs: number;
  sequence: number;
  configurationOffset: number;
}): SpectrumFrame[] | undefined {
  const frames: SpectrumFrame[] = [];
  for (let index = 0; index < FRAMES_PER_VISIT; index += 1) {
    const frameMonotonicMs = input.completionMs - (FRAMES_PER_VISIT - 1 - index) * RAW_FRAME_INTERVAL_MS;
    const generatedBins = input.validationRun.frameAt(input.target.id, frameMonotonicMs);
    if (!generatedBins) return undefined;
    const bins = analysisBins(generatedBins);
    const receivedAtMs = FIXED_EPOCH_MS + frameMonotonicMs;
    frames.push({
      id: `synthetic-frame-${input.sequence}-${index}`,
      timestamp: new Date(receivedAtMs).toISOString(),
      receiver: 0,
      bandId: input.bandId,
      targetId: input.target.id,
      startHz: input.target.centerHz - input.target.analysisSpanHz / 2,
      endHz: input.target.centerHz + input.target.analysisSpanHz / 2,
      bins,
      inputBinCount: BIN_COUNT,
      analysisStartBin: ANALYSIS_START_BIN,
      analysisEndBin: ANALYSIS_END_BIN,
      analysisSpanHz: input.target.analysisSpanHz,
      captureSpanHz: input.target.captureSpanHz,
      source: "simulation",
      dataDomain: "test",
      calibrated: false,
      configurationEpoch: input.configurationOffset + 1,
      tuneEpoch: input.sequence + 1,
      visitEpoch: input.sequence + 1,
      visitId: `synthetic-visit-${input.sequence}`,
      receivedMonotonicMs: frameMonotonicMs,
      requestedCenterHz: input.target.centerHz,
      confirmedCenterHz: input.target.centerHz,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(receivedAtMs - 250).toISOString(),
    });
  }
  return frames;
}

function observedOutcome(score: SyntheticRunScore): "alert" | "no-alert" | "unknown" {
  if (score.detectedExpectedEvents > 0 || score.unexpectedAlerts > 0) return "alert";
  if (score.observedUnknownEvents > 0) return "unknown";
  return "no-alert";
}

function qualificationArtifacts(input: {
  options: SyntheticQualificationRunnerOptions;
  target: PhysicalCaptureTarget;
  ruleHash: string;
  thresholds: DetectionThresholds;
}): SyntheticArtifactInputs {
  const catalog = input.options.bandCatalog!;
  return {
    softwareBuild: input.options.softwareBuild ?? { package: "rf-monitor", version: "1.0.0" },
    configuration: input.options.configuration ?? {
      source: "isolated-simulation",
      dataDomain: "test",
      targetId: input.target.id,
      centerHz: input.target.centerHz,
      sampleRateHz: 10_000_000,
      binCount: BIN_COUNT,
      captureSpanHz: input.target.captureSpanHz,
      analysisSpanHz: input.target.analysisSpanHz,
      visitIntervalMs: VISIT_INTERVAL_MS,
      catalogVersion: catalog.catalogVersion,
    },
    ruleSet: input.thresholds,
    baseline: {
      dataDomain: "test",
      source: "synthetic-pre-run-training",
      observations: TRAINING_OBSERVATIONS,
      fingerprint: fingerprint(input.target, catalog.catalogVersion, 0, input.ruleHash),
    },
  };
}

/** Creates and exposes the blinded commitment before any detector processing. */
export function prepareSyntheticQualificationDefinition(
  scenario: SyntheticScenarioDefinition,
  mode: SyntheticRunMode,
  options: SyntheticQualificationRunnerOptions,
): PreparedSyntheticQualificationRun {
  if (mode !== "guided" && mode !== "blinded") throw new Error("Mode must be guided or blinded");
  if (!options.bandCatalog) throw new Error("Active band catalog is required for a qualification report");
  if (scenario.targets.length !== 1 || scenario.events.length !== 1) {
    throw new Error("Isolated qualification scenarios must contain exactly one target and one truth event");
  }
  if (scenario.targets[0].binCount !== BIN_COUNT) throw new Error(`Isolated qualification scenarios must use ${BIN_COUNT} input bins`);
  const targetId = scenario.targets[0].id;
  const target = qualificationTarget(targetId, options.bandCatalog);
  const thresholds = structuredClone(options.thresholds ?? DEFAULT_THRESHOLDS);
  const ruleHash = detectionRuleFingerprint(thresholds);
  const runId = options.runId ?? randomUUID();
  const validationRun = new SyntheticValidationRun({
    scenario,
    mode,
    runId,
    artifacts: qualificationArtifacts({ options, target, ruleHash, thresholds }),
  });
  return {
    runId,
    targetId,
    ruleSetHash: ruleHash,
    metadata: validationRun.getMetadata(),
    provenance: validationRun.provenance,
  };
}

export function runSyntheticQualificationScenario(
  scenarioId: string,
  mode: SyntheticRunMode,
  options: SyntheticQualificationRunnerOptions = {},
): SyntheticQualificationReport {
  if (!options.bandCatalog) throw new Error("Active band catalog is required for a qualification report");
  const seedPrefix = options.seedPrefix ?? "rf-monitor-qualification-v1";
  const scenario = scenarioSuite(seedPrefix, TARGET_ID).find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error("Unknown synthetic validation scenario");
  return runSyntheticQualificationDefinition(scenario, mode, {
    ...options,
    qualificationLevel: "isolated-deterministic",
  });
}

/**
 * Executes one frozen generated scenario through the same visit aggregation and
 * DetectionEngine path used by the deterministic fixtures. It has no storage,
 * baseline-store, incident-store, or field-domain dependency.
 */
export function runSyntheticQualificationDefinition(
  scenario: SyntheticScenarioDefinition,
  mode: SyntheticRunMode,
  options: SyntheticQualificationRunnerOptions,
): SyntheticQualificationReport {
  if (!options.bandCatalog) throw new Error("Active band catalog is required for a qualification report");
  const prepared = prepareSyntheticQualificationDefinition(scenario, mode, options);
  const targetId = scenario.targets[0].id;
  const target = qualificationTarget(targetId, options.bandCatalog);
  const band = validationBand(targetId, options.bandCatalog);
  const bandId = target.relatedBandIds[0];

  const thresholds = structuredClone(options.thresholds ?? DEFAULT_THRESHOLDS);
  const ruleHash = detectionRuleFingerprint(thresholds);
  const runId = prepared.runId;
  const validationRun = new SyntheticValidationRun({
    scenario,
    mode,
    runId,
    artifacts: qualificationArtifacts({ options, target, ruleHash, thresholds }),
  });
  const metadata = validationRun.getMetadata();
  if (metadata.truthCommitment !== prepared.metadata.truthCommitment) {
    throw new Error(`Prepared truth commitment changed before detector execution for ${runId}`);
  }
  if (options.expectedTruthCommitment && metadata.truthCommitment !== options.expectedTruthCommitment) {
    throw new Error(`Pre-run truth commitment mismatch for ${runId}`);
  }
  const detector = new DetectionEngine(thresholds, () => 0.5);

  // Qualification starts from a deterministic, scenario-independent quiet
  // reference. This tests detector behaviour; it does not assert that a field
  // baseline is clean or calibrated.
  for (let index = 0; index < TRAINING_OBSERVATIONS; index += 1) {
    const queryMs = (index * RAW_FRAME_INTERVAL_MS) % 4_500;
    const bins = validationRun.frameAt(targetId, queryMs);
    if (!bins) throw new Error("Synthetic training reference unexpectedly contains a data gap");
    detector.analyzeObservation(directObservation({
      bins,
      target,
      catalogVersion: options.bandCatalog.catalogVersion,
      bandId,
      sequence: index,
      observedMonotonicMs: -TRAINING_OBSERVATIONS * VISIT_INTERVAL_MS + index * VISIT_INTERVAL_MS,
      configurationOffset: 0,
      overload: false,
      detectionRuleHash: ruleHash,
    }), band);
  }

  const alerts: ValidationObservedAlert[] = [];
  const observations: ValidationObservationWindow[] = [];
  const clearHorizonMs = thresholds.clearObservations * VISIT_INTERVAL_MS;
  let activeAlert: ValidationObservedAlert | undefined;
  for (let completionMs = 500, sequence = 0; completionMs < scenario.durationMs; completionMs += VISIT_INTERVAL_MS, sequence += 1) {
    const startMonotonicMs = completionMs - 500;
    const state = validationRun.sensorStateAt(targetId, completionMs);
    const frames = visitFrames({ validationRun, target, bandId, completionMs, sequence, configurationOffset: state.configurationOffset });
    if (!frames) {
      observations.push({ targetId, startMonotonicMs, endMonotonicMs: completionMs, outcome: "unknown", reason: "data-gap" });
      activeAlert = undefined;
      continue;
    }
    const outcome = aggregateVisitFrames({
      frames,
      targetId,
      visitId: `synthetic-visit-${sequence}`,
      configurationEpoch: state.configurationOffset + 1,
      tuneEpoch: sequence + 1,
      visitEpoch: sequence + 1,
      affectedBandIds: [...target.relatedBandIds],
      fingerprint: fingerprint(target, options.bandCatalog.catalogVersion, state.configurationOffset, ruleHash),
      overload: state.overload,
      healthComplete: true,
    });
    if (outcome.status === "unknown") {
      observations.push({ targetId: TARGET_ID, startMonotonicMs, endMonotonicMs: completionMs, outcome: "unknown", reason: outcome.reason });
      activeAlert = undefined;
      continue;
    }
    const result = detector.analyzeObservation(outcome.observation, band, {
      freezeTraining: state.configurationOffset !== 0 || state.overload,
    });
    observations.push({
      targetId,
      startMonotonicMs,
      endMonotonicMs: completionMs,
      outcome: result.disposition === "unknown" ? "unknown" : "valid",
      ...(result.disposition === "unknown" ? { reason: state.configurationOffset ? "configuration-change" : "detector-checking" } : {}),
    });
    if (!result.event) continue;
    if (!activeAlert || activeAlert.kind !== result.event.kind || completionMs - (activeAlert.lastSeenMonotonicMs ?? activeAlert.startedMonotonicMs) > clearHorizonMs) {
      activeAlert = {
        id: `synthetic-alert-${alerts.length + 1}`,
        targetId,
        kind: result.event.kind,
        startedMonotonicMs: completionMs,
        lastSeenMonotonicMs: completionMs,
      };
      alerts.push(activeAlert);
    } else {
      activeAlert.lastSeenMonotonicMs = completionMs;
    }
  }

  // Blinded metadata carries only the commitment until detector processing is
  // complete. Truth is disclosed here for scoring and commitment verification.
  const truth = validationRun.discloseTruth();
  const score = validationRun.score(alerts, observations, clearHorizonMs);
  const disclosureVerified = verifySyntheticTruthDisclosure(metadata, truth);
  const alertKinds = [...new Set(alerts.map((alert) => alert.kind).filter((kind): kind is DetectionKind => Boolean(kind)))] as DetectionKind[];
  const summary: SyntheticScenarioSummary = {
    id: scenario.id,
    name: SCENARIO_NAMES[scenario.events[0].kind] ?? scenario.name,
    version: scenario.version,
    durationMs: scenario.durationMs,
    expectedOutcome: scenario.events[0].expected.outcome,
    target: { id: target.id, label: target.label, centerHz: target.centerHz },
  };
  const qualificationPlan = detectorQualificationPlan(options.bandCatalog);
  return {
    schemaVersion: SYNTHETIC_QUALIFICATION_REPORT_VERSION,
    synthetic: true,
    source: "isolated-simulation",
    qualification: {
      planVersion: qualificationPlan.version,
      planHash: sha256Canonical(qualificationPlan),
      level: options.qualificationLevel ?? "isolated-deterministic",
      installedChain: "not-run",
    },
    runId,
    mode,
    scenario: summary,
    detector: {
      implementation: "DetectionEngine",
      ruleSetId: thresholds.ruleSetId,
      trainingObservations: TRAINING_OBSERVATIONS,
      visitIntervalMs: VISIT_INTERVAL_MS,
      framesPerVisit: FRAMES_PER_VISIT,
    },
    provenance: validationRun.provenance,
    truth: {
      commitment: metadata.truthCommitment,
      disclosedAfterRun: mode === "blinded",
      verified: disclosureVerified,
    },
    observed: {
      outcome: observedOutcome(score),
      alertKinds,
      validObservations: observations.filter((observation) => observation.outcome === "valid").length,
      unknownObservations: observations.filter((observation) => observation.outcome === "unknown").length,
      receiverOverload: alertKinds.includes("overload"),
      rfAnomalyAlert: alertKinds.some((kind) => kind !== "overload"),
    },
    score,
    passed: disclosureVerified && score.passed,
  };
}
