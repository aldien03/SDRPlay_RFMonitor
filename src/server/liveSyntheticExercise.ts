import { randomUUID } from "node:crypto";
import {
  aggregateVisitFrames,
  createBaselineFingerprint,
  detectionRuleFingerprint,
  DetectionEngine,
  type DetectionResult,
  type DetectionThresholds,
} from "../shared/detection";
import type {
  BandPreset,
  ChannelMonitorState,
  PhysicalCaptureTarget,
  SpectrumFrame,
  SyntheticExerciseMarker,
  SyntheticExerciseState,
  TargetVisitUnknownReason,
  TargetObservation,
} from "../shared/types";
import type { SyntheticExpectedOutcome, SyntheticScenarioDefinition, SyntheticSensorState } from "../shared/syntheticValidation";
import { SyntheticValidationRun, createResearchSyntheticScenarioSuite } from "./syntheticValidation";

export const LIVE_SYNTHETIC_TARGET_ID = "gnss-l1-e1-b1c-sbas";
export const LIVE_SYNTHETIC_BAND_ID = "gps-l1";
export const LIVE_SYNTHETIC_CENTER_HZ = 1_575_420_000;
export const LIVE_SYNTHETIC_CAPTURE_START_HZ = 1_570_420_000;
export const LIVE_SYNTHETIC_CAPTURE_END_HZ = 1_580_420_000;
export const LIVE_SYNTHETIC_BIN_COUNT = 640;
export const LIVE_SYNTHETIC_ANALYSIS_START_BIN = 64;
export const LIVE_SYNTHETIC_ANALYSIS_END_BIN = 576;

const TRAINING_OBSERVATIONS = 64;
const RAW_FRAME_INTERVAL_MS = 250;
const MAX_RUN_MS = 120_000;
const COMPLETE_HOLD_MS = 60_000;
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

export interface LiveSyntheticSample {
  bins?: Uint8Array;
  sensorState: SyntheticSensorState;
  marker: SyntheticExerciseMarker;
  elapsedMs: number;
}

export interface LiveSyntheticAnalysis {
  result?: DetectionResult;
  unknownReason?: TargetVisitUnknownReason;
}

export interface LiveSyntheticExerciseOptions {
  scenarioId: string;
  thresholds: DetectionThresholds;
  /** Exact enabled physical target exercised through the normal scheduler. */
  target?: PhysicalCaptureTarget;
  /** Enabled logical labels attributed to the physical target. */
  affectedBands?: BandPreset[];
  excludedVisitId?: string;
  nowMonotonicMs?: number;
  nowWallMs?: number;
  configurationHash: string;
  catalogVersion: string;
  sampleRateHz: number;
}

function suite(targetId = LIVE_SYNTHETIC_TARGET_ID, revisitObjectiveMs = 2_000): SyntheticScenarioDefinition[] {
  const scenarios = createResearchSyntheticScenarioSuite({
    seedPrefix: targetId === LIVE_SYNTHETIC_TARGET_ID
      ? "rf-monitor-live-exercise-v1"
      : `rf-monitor-live-exercise-v1:${targetId}`,
    target: {
      id: targetId,
      binCount: LIVE_SYNTHETIC_BIN_COUNT,
      baselineLevel: 32,
      noiseAmplitudeBins: 2,
      rippleAmplitudeBins: 2,
    },
  });
  // A 3-of-5 detector with a two-second exposure floor cannot be exercised by
  // the original 10-second event window on a target revisited every six
  // seconds. Stretch truth time, not detector thresholds or scheduler time, so
  // the live exercise remains observable through the real single-tuner gaps.
  const scale = Math.max(1, Math.ceil(revisitObjectiveMs / 2_000));
  if (scale === 1) return scenarios;
  return scenarios.map((scenario) => ({
    ...scenario,
    version: `${scenario.version}-schedule-x${scale}`,
    durationMs: scenario.durationMs * scale,
    events: scenario.events.map((event) => ({
      ...event,
      startMonotonicMs: event.startMonotonicMs * scale,
      endMonotonicMs: event.endMonotonicMs * scale,
      ...("periodMs" in event ? { periodMs: event.periodMs * scale } : {}),
      ...("sweepPeriodMs" in event ? { sweepPeriodMs: event.sweepPeriodMs * scale } : {}),
    })),
  }));
}

export function isLiveSyntheticScenario(scenarioId: string): boolean {
  return suite().some((scenario) => scenario.id === scenarioId);
}

function band(): BandPreset {
  return {
    id: LIVE_SYNTHETIC_BAND_ID,
    label: "GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1",
    service: "gnss",
    startHz: 1_571_420_000,
    endHz: 1_579_420_000,
    centerHz: LIVE_SYNTHETIC_CENTER_HZ,
    captureTargetId: LIVE_SYNTHETIC_TARGET_ID,
    captureCenterHz: LIVE_SYNTHETIC_CENTER_HZ,
    captureSpanHz: 10_000_000,
    analysisSpanHz: 8_000_000,
    priority: 1,
    dwellMs: 1_000,
    editable: false,
  };
}

function exerciseBand(target: PhysicalCaptureTarget | undefined, affectedBands: BandPreset[] | undefined): BandPreset {
  if (!target) return band();
  const primary = affectedBands?.find((candidate) => candidate.captureTargetId === target.id);
  const analysisHalfSpanHz = target.analysisSpanHz / 2;
  return {
    ...(primary ?? band()),
    id: primary?.id ?? target.relatedBandIds[0] ?? target.id,
    label: target.label,
    service: target.service,
    startHz: target.centerHz - analysisHalfSpanHz,
    endHz: target.centerHz + analysisHalfSpanHz,
    centerHz: target.nominalDisplayHz ?? target.centerHz,
    captureTargetId: target.id,
    captureCenterHz: target.centerHz,
    captureSpanHz: target.captureSpanHz,
    analysisSpanHz: target.analysisSpanHz,
    revisitObjectiveMs: target.revisitObjectiveMs,
    nominalVisitMs: target.nominalVisitMs,
    maxVisitMs: target.maxVisitMs,
    tuneAckTimeoutMs: target.tuneAckTimeoutMs,
    settleMs: target.settleMs,
    discardFrames: target.discardFrames,
    minFreshFrames: target.minFreshFrames,
    priority: 1,
    dwellMs: target.nominalVisitMs,
    editable: false,
  };
}

function fingerprint(
  target: PhysicalCaptureTarget | undefined,
  configurationOffset: number,
  sampleRateHz: number,
  catalogVersion: string,
  detectionRuleHash: string,
) {
  const targetId = target?.id ?? LIVE_SYNTHETIC_TARGET_ID;
  const centerHz = target?.centerHz ?? LIVE_SYNTHETIC_CENTER_HZ;
  const analysisSpanHz = target?.analysisSpanHz ?? 8_000_000;
  const captureSpanHz = target?.captureSpanHz ?? 10_000_000;
  return createBaselineFingerprint({
    dataDomain: "test",
    receiverIdentity: "synthetic:live-exercise-receiver-0",
    receiverKey: "synthetic-exercise-receiver-0",
    deviceName: "Synthetic FFT exercise",
    sdrconnectVersion: "not-used",
    activeAntenna: "synthetic",
    gainProfileId: `synthetic-fixed-${configurationOffset}`,
    targetId,
    centerHz,
    sampleRateHz,
    inputBinCount: LIVE_SYNTHETIC_BIN_COUNT,
    analysisStartBin: LIVE_SYNTHETIC_ANALYSIS_START_BIN,
    analysisEndBin: LIVE_SYNTHETIC_ANALYSIS_END_BIN,
    analysisMaskHash: `synthetic-center-${analysisSpanHz}-of-${captureSpanHz}hz`,
    spectrumReference: 0,
    spectrumBase: 0,
    catalogVersion,
    detectionRuleHash,
  });
}

function trainingObservation(
  target: PhysicalCaptureTarget | undefined,
  targetBand: BandPreset,
  affectedBandIds: string[],
  bins: Uint8Array,
  sequence: number,
  observedAtMs: number,
  sampleRateHz: number,
  catalogVersion: string,
  detectionRuleHash: string,
): TargetObservation {
  const targetFingerprint = fingerprint(target, 0, sampleRateHz, catalogVersion, detectionRuleHash);
  const targetId = target?.id ?? LIVE_SYNTHETIC_TARGET_ID;
  return {
    dataDomain: "test",
    id: `synthetic-exercise-training-${sequence}`,
    visitId: `synthetic-exercise-training-visit-${sequence}`,
    configurationEpoch: 1,
    tuneEpoch: sequence + 1,
    visitEpoch: sequence + 1,
    targetId,
    receiver: 0,
    bandId: targetBand.id,
    affectedBandIds,
    observedAt: new Date(observedAtMs).toISOString(),
    firstFrameAt: new Date(observedAtMs - 500).toISOString(),
    lastFrameAt: new Date(observedAtMs).toISOString(),
    exposureMs: 500,
    acceptedFrameCount: 3,
    bins: bins.slice(LIVE_SYNTHETIC_ANALYSIS_START_BIN, LIVE_SYNTHETIC_ANALYSIS_END_BIN),
    confirmedCenterHz: targetFingerprint.centerHz,
    confirmedSampleRateHz: targetFingerprint.sampleRateHz,
    tuneConfirmedAt: new Date(observedAtMs - 750).toISOString(),
    fingerprint: targetFingerprint,
    overload: false,
    healthComplete: true,
  };
}

function expectedVerdict(expected: SyntheticExpectedOutcome, observed: "alert" | "no-alert" | "unknown", scenarioId: string): string {
  if (expected !== observed) {
    if (expected === "alert" && observed === "no-alert") return "Interference not detected";
    if (observed === "alert") return "Unexpected RF alert";
    return "Unexpected test result";
  }
  if (observed === "alert") return scenarioId === "overload" ? "Receiver overloaded" : "Suspected RF interference";
  if (observed === "unknown") return "Test inconclusive";
  return scenarioId === "matched-power-spoofing" ? "No RF change detected" : "No RF anomaly";
}

/**
 * Owns one bounded, ephemeral detector exercise. The production detector,
 * baseline store, and commissioning counters never enter this class. The
 * monitor service may persist bounded outputs through its isolated test-domain
 * evidence writer.
 */
export class LiveSyntheticExercise {
  readonly marker: SyntheticExerciseMarker;
  readonly targetBand: BandPreset;
  readonly targetId: string;
  readonly targetCenterHz: number;
  readonly affectedBandIds: string[];
  readonly scenario: SyntheticScenarioDefinition;
  readonly detector: DetectionEngine;
  readonly excludedVisitId?: string;
  private readonly validationRun: SyntheticValidationRun;
  private readonly sampleRateHz: number;
  private readonly catalogVersion: string;
  private readonly detectionRuleHash: string;
  private readonly target?: PhysicalCaptureTarget;
  private readonly createdMonotonicMs: number;
  private readonly createdWallMs: number;
  private startedMonotonicMs?: number;
  private startedWallMs?: number;
  private completedMonotonicMs?: number;
  private completedWallMs?: number;
  private alertObserved = false;
  private unknownObserved = false;
  private stopRequested = false;
  private latestElapsedMs = 0;
  private latestTargetState?: ChannelMonitorState;

  constructor(options: LiveSyntheticExerciseOptions) {
    const targetId = options.target?.id ?? LIVE_SYNTHETIC_TARGET_ID;
    const scenario = suite(targetId, options.target?.revisitObjectiveMs).find((candidate) => candidate.id === options.scenarioId);
    if (!scenario) throw new Error("Unknown synthetic exercise scenario");
    this.scenario = scenario;
    this.target = options.target ? structuredClone(options.target) : undefined;
    this.targetId = targetId;
    this.targetCenterHz = options.target?.centerHz ?? LIVE_SYNTHETIC_CENTER_HZ;
    this.targetBand = exerciseBand(options.target, options.affectedBands);
    this.affectedBandIds = (options.affectedBands ?? [this.targetBand])
      .filter((candidate) => candidate.captureTargetId === this.targetId || !options.target)
      .map((candidate) => candidate.id);
    if (!this.affectedBandIds.length) this.affectedBandIds = [this.targetBand.id];
    this.excludedVisitId = options.excludedVisitId;
    this.sampleRateHz = options.sampleRateHz;
    this.catalogVersion = options.catalogVersion;
    this.detectionRuleHash = detectionRuleFingerprint(options.thresholds);
    this.createdMonotonicMs = options.nowMonotonicMs ?? performance.now();
    this.createdWallMs = options.nowWallMs ?? Date.now();
    const runId = randomUUID();
    this.validationRun = new SyntheticValidationRun({
      scenario,
      mode: "guided",
      runId,
      artifacts: {
        softwareBuild: { package: "rf-monitor", feature: "live-synthetic-exercise" },
        configuration: {
          configurationHash: options.configurationHash,
          catalogVersion: options.catalogVersion,
          sampleRateHz: options.sampleRateHz,
          targetId: this.targetId,
        },
        ruleSet: options.thresholds,
        baseline: { source: "ephemeral-quiet-seed", observations: TRAINING_OBSERVATIONS },
      },
    });
    const provenance = this.validationRun.provenance;
    this.marker = {
      synthetic: true,
      runId,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scenarioHash: provenance.scenarioHash,
      validationProtocolVersion: provenance.validationProtocolVersion,
      generatorVersion: provenance.generatorVersion,
    };
    this.detector = new DetectionEngine(structuredClone(options.thresholds), () => 0.5);
    for (let index = 0; index < TRAINING_OBSERVATIONS; index += 1) {
      const queryMs = (index * RAW_FRAME_INTERVAL_MS) % 4_500;
      const bins = this.validationRun.frameAt(this.targetId, queryMs);
      if (!bins) throw new Error("Synthetic exercise quiet seed contains a data gap");
      this.detector.analyzeObservation(trainingObservation(
        this.target,
        this.targetBand,
        this.affectedBandIds,
        bins,
        index,
        this.createdWallMs - (TRAINING_OBSERVATIONS - index) * 1_000,
        this.sampleRateHz,
        this.catalogVersion,
        this.detectionRuleHash,
      ), this.targetBand);
    }
  }

  sample(targetId: string | undefined, visitId: string | undefined, nowMonotonicMs = performance.now(), nowWallMs = Date.now()): LiveSyntheticSample | undefined {
    if (targetId !== this.targetId || !visitId || visitId === this.excludedVisitId || this.isExpired(nowMonotonicMs)) return undefined;
    if (this.startedMonotonicMs === undefined) {
      this.startedMonotonicMs = nowMonotonicMs;
      this.startedWallMs = nowWallMs;
    }
    const elapsedMs = Math.max(0, Math.floor(nowMonotonicMs - this.startedMonotonicMs));
    this.latestElapsedMs = elapsedMs;
    const forceQuiet = this.stopRequested || elapsedMs >= this.scenario.durationMs;
    const queryMs = forceQuiet
      ? 4_000 + (elapsedMs % 500)
      : Math.min(this.scenario.durationMs, elapsedMs);
    const sensorState = forceQuiet
      ? { dataAvailable: true, overload: false, configurationOffset: 0 }
      : this.validationRun.sensorStateAt(this.targetId, queryMs);
    const bins = forceQuiet
      ? this.validationRun.frameAt(this.targetId, queryMs)
      : this.validationRun.frameAt(this.targetId, queryMs);
    return { bins, sensorState, marker: this.marker, elapsedMs };
  }

  analyzeVisit(frames: SpectrumFrame[], configurationOffset: number, overload: boolean): LiveSyntheticAnalysis {
    const first = frames[0];
    if (!first?.visitId || first.configurationEpoch === undefined || first.tuneEpoch === undefined || first.visitEpoch === undefined) {
      this.noteUnknown();
      return { unknownReason: "insufficient-frames" };
    }
    const outcome = aggregateVisitFrames({
      frames,
      targetId: this.targetId,
      visitId: first.visitId,
      configurationEpoch: first.configurationEpoch,
      tuneEpoch: first.tuneEpoch,
      visitEpoch: first.visitEpoch,
      affectedBandIds: this.affectedBandIds,
      fingerprint: fingerprint(this.target, configurationOffset, this.sampleRateHz, this.catalogVersion, this.detectionRuleHash),
      overload,
      healthComplete: true,
    });
    if (outcome.status === "unknown") {
      this.noteUnknown();
      return { unknownReason: outcome.reason };
    }
    const result = this.detector.analyzeObservation(outcome.observation, this.targetBand, {
      freezeTraining: overload || configurationOffset !== 0 || this.alertObserved,
    });
    if (result.event) this.alertObserved = true;
    if (result.disposition === "unknown" && configurationOffset !== 0) this.noteUnknown();
    return { result };
  }

  noteUnknown(): void {
    this.unknownObserved = true;
  }

  observeTargetState(targetState: ChannelMonitorState, nowMonotonicMs = performance.now(), nowWallMs = Date.now()): void {
    this.latestTargetState = { ...targetState };
    if (targetState.lifecycle === "active") this.alertObserved = true;
    const expected = this.expectedOutcome;
    if (this.alertObserved && targetState.lifecycle === "clear" && targetState.clearedAt) {
      this.complete("alert", nowMonotonicMs, nowWallMs);
      return;
    }
    if (this.latestElapsedMs < this.scenario.durationMs || this.completedMonotonicMs !== undefined) return;
    if (expected === "unknown" && this.unknownObserved) this.complete("unknown", nowMonotonicMs, nowWallMs);
    else if (!this.alertObserved) this.complete("no-alert", nowMonotonicMs, nowWallMs);
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  ownsVisit(targetId: string | undefined, visitId: string | undefined): boolean {
    return targetId === this.targetId
      && Boolean(visitId)
      && visitId !== this.excludedVisitId
      && this.startedMonotonicMs !== undefined;
  }

  get hasActiveAlert(): boolean {
    return this.latestTargetState?.lifecycle === "active" || this.latestTargetState?.lifecycle === "recovering";
  }

  get isComplete(): boolean {
    return this.completedMonotonicMs !== undefined;
  }

  isExpired(nowMonotonicMs = performance.now()): boolean {
    if (nowMonotonicMs - this.createdMonotonicMs >= MAX_RUN_MS) return true;
    return this.completedMonotonicMs !== undefined && nowMonotonicMs - this.completedMonotonicMs >= COMPLETE_HOLD_MS;
  }

  getState(nowMonotonicMs = performance.now()): SyntheticExerciseState {
    const expectedOutcome = this.expectedOutcome;
    const elapsedMs = this.startedMonotonicMs === undefined
      ? 0
      : Math.max(this.latestElapsedMs, Math.floor(nowMonotonicMs - this.startedMonotonicMs));
    const targetState = this.latestTargetState;
    const observedOutcome = this.completedMonotonicMs === undefined
      ? undefined
      : this.alertObserved ? "alert" as const : this.unknownObserved ? "unknown" as const : "no-alert" as const;
    const phase = this.completedMonotonicMs !== undefined
      ? "complete" as const
      : this.startedMonotonicMs === undefined
        ? "waiting-for-target" as const
        : targetState?.lifecycle === "active"
          ? "alert" as const
          : targetState?.lifecycle === "recovering"
            ? "recovering" as const
            : expectedOutcome === "unknown" && this.unknownObserved
              ? "inconclusive" as const
              : "running" as const;
    return {
      ...this.marker,
      targetId: this.targetId,
      targetLabel: this.targetBand.label,
      centerHz: this.targetCenterHz,
      scenarioName: SCENARIO_NAMES[this.scenario.id] ?? this.scenario.name,
      expectedOutcome,
      phase,
      startedAt: this.startedWallMs === undefined ? undefined : new Date(this.startedWallMs).toISOString(),
      completedAt: this.completedWallMs === undefined ? undefined : new Date(this.completedWallMs).toISOString(),
      elapsedMs,
      durationMs: this.scenario.durationMs,
      progress: Math.max(0, Math.min(1, elapsedMs / this.scenario.durationMs)),
      cleanChecks: targetState?.lifecycle === "recovering" ? targetState.clearCount : targetState?.lifecycle === "clear" && this.alertObserved ? targetState.requiredCount : 0,
      requiredCleanChecks: targetState?.requiredCount ?? 10,
      observedOutcome,
      verdict: observedOutcome ? expectedVerdict(expectedOutcome, observedOutcome, this.scenario.id) : undefined,
      stopRequested: this.stopRequested || undefined,
    };
  }

  private get expectedOutcome(): SyntheticExpectedOutcome {
    return this.scenario.events[0]?.expected.outcome ?? "unknown";
  }

  private complete(observed: "alert" | "no-alert" | "unknown", nowMonotonicMs: number, nowWallMs: number): void {
    if (this.completedMonotonicMs !== undefined) return;
    if (observed === "alert") this.alertObserved = true;
    if (observed === "unknown") this.unknownObserved = true;
    this.completedMonotonicMs = nowMonotonicMs;
    this.completedWallMs = nowWallMs;
  }
}
