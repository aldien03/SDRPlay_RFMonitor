import { createHash, randomUUID } from "node:crypto";
import type {
  BandPreset,
  BaselineDescriptor,
  BaselineFingerprint,
  DetectorAnomalyBinRange,
  DetectorSpectrumAnalysis,
  DetectionEvent,
  DetectionKind,
  DetectionRuleSettings,
  ObservationDisposition,
  SignalMetricSample,
  SpectrumFrame,
  TargetObservation,
  TargetVisitOutcome,
} from "./types";

export type DetectionThresholds = DetectionRuleSettings;

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  ruleSetId: "rf-relative-mad-v1",
  scaleFloorBins: 1,
  widebandObservationSigma: 6,
  widebandObservationOccupancy: 0.35,
  interferenceSigma: 8,
  interferenceOccupancy: 0.5,
  interferenceHits: 3,
  interferenceWindow: 5,
  interferenceExposureMs: 2_000,
  narrowbandPeakSigma: 10,
  narrowbandMaxWidthRatio: 0.1,
  driftSigma: 4,
  driftExposureMs: 10_000,
  clearObservations: 10,
  reservoirSize: 256,
  minimumLearningMs: 30 * 60_000,
};

const DETECTOR_VERSION = "relative-mad-1";
const MIN_BASELINE_OBSERVATIONS = 64;
// Establish a small robust seed before using relative detector rules as a
// learning gate. The seed cannot prove a clean RF environment, but once it is
// present a transient energy rise must not be allowed to teach itself into the
// commissioning baseline.
const MIN_BOOTSTRAP_REFERENCE_OBSERVATIONS = 8;
const REPRESENTATIVE_HOURS = 24;
const MAX_HOUR_BUCKETS = 168;
const MAX_CANDIDATE_GAP_MS = 30_000;
const MAX_DETECTOR_STATES = 32;

interface CandidateVote {
  kind?: DetectionKind;
  exposureMs: number;
  observedAtMs: number;
}

interface BaselineState {
  dataDomain: BaselineFingerprint["dataDomain"];
  targetId: string;
  fingerprintId: string;
  learningGenerationId: string;
  lifecycle: BaselineDescriptor["lifecycle"];
  learningStartedAtMs: number;
  observationsSeen: number;
  validVisits: number;
  expectedVisits: number;
  reservoirCount: number;
  reservoir: Uint8Array;
  binCount: number;
  medians: Uint8Array;
  mads: Uint8Array;
  /** Bumped whenever a reservoir slot is written; medians/mads are derived from it alone. */
  reservoirRevision: number;
  /** The reservoirRevision the current medians/mads were derived from; -1 means never derived. */
  derivedRevision: number;
  representativeHours: Map<string, { valid: number; expected: number; eligible: boolean }>;
  votes: CandidateVote[];
  driftExposureMs: number;
  lastDriftAtMs?: number;
  lastObservedAtMs: number;
  protectedAt?: string;
}

export interface DetectionCandidate {
  kind: DetectionKind;
  hits: number;
  window: number;
  observedExposureMs: number;
  count: number;
  required: number;
}

export interface DetectionResult {
  disposition: ObservationDisposition;
  metrics: SignalMetricSample;
  baseline: BaselineDescriptor;
  event?: Omit<DetectionEvent, "id" | "sessionId" | "notes">;
  candidate?: DetectionCandidate;
  alertEligible: boolean;
  /** The detector's single source of truth for persistent baseline admission. */
  trainingEligible: boolean;
  unknownReason?: "observation-ineligible" | "baseline-unavailable" | "baseline-mismatch";
  /** Detector-owned display semantics for this exact observation. */
  analysis: DetectorObservationAnalysis;
}

export interface DetectorObservationAnalysis {
  observationId: string;
  ruleSetId: string;
  disposition: ObservationDisposition;
  analyzedRangeHz: [number, number];
  inputBinCount: number;
  baselineAvailable: boolean;
  overload: boolean;
  anomalyKind?: Exclude<DetectionKind, "gnss-energy-anomaly" | "overload">;
  anomalyBinRanges: DetectorAnomalyBinRange[];
}

export interface DetectionBaselineReference {
  descriptor: BaselineDescriptor;
  medians: Uint8Array;
  mads: Uint8Array;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

export function baselineFingerprintId(fingerprint: BaselineFingerprint): string {
  return createHash("sha256").update(JSON.stringify(canonical(fingerprint))).digest("hex");
}

export function detectionRuleFingerprint(settings: DetectionRuleSettings): string {
  return createHash("sha256").update(JSON.stringify(canonical(settings))).digest("hex");
}

export function createBaselineFingerprint(input: Omit<BaselineFingerprint, "schemaVersion" | "detectorVersion">): BaselineFingerprint {
  if (!input.receiverIdentity.trim()) throw new Error("Baseline fingerprint requires a receiver identity");
  if (!/^[a-f0-9]{64}$/.test(input.detectionRuleHash)) throw new Error("Baseline fingerprint requires a canonical detector-rule hash");
  return { ...input, schemaVersion: 1, detectorVersion: DETECTOR_VERSION };
}

function medianOfThree(left: number, middle: number, right: number): number {
  if (left > middle) [left, middle] = [middle, left];
  if (middle > right) [middle, right] = [right, middle];
  return left > middle ? left : middle;
}

export function aggregateVisitFrames(input: {
  frames: SpectrumFrame[];
  targetId: string;
  visitId: string;
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  affectedBandIds: string[];
  fingerprint: BaselineFingerprint;
  overload?: boolean;
  healthComplete?: boolean;
}): TargetVisitOutcome {
  const observedAt = input.frames.at(-1)?.timestamp ?? new Date().toISOString();
  const unknown = (reason: Extract<TargetVisitOutcome, { status: "unknown" }>['reason']): TargetVisitOutcome => ({
    status: "unknown", targetId: input.targetId, visitId: input.visitId, observedAt, reason,
  });
  const matching = input.frames.filter((frame) => frame.targetId === input.targetId
    && frame.visitId === input.visitId
    && frame.configurationEpoch === input.configurationEpoch
    && frame.tuneEpoch === input.tuneEpoch
    && frame.visitEpoch === input.visitEpoch);
  if (matching.length < 3) return unknown("insufficient-frames");
  if (matching.some((frame) => !frame.dataDomain || frame.dataDomain !== input.fingerprint.dataDomain)) return unknown("receiver-unhealthy");
  const selected = matching.slice(0, 5);
  const binCount = selected[0].bins.length;
  if (!binCount || selected.some((frame) => frame.bins.length !== binCount)) return unknown("bin-grid-changed");
  if (selected.some((frame) => frame.confirmedCenterHz !== input.fingerprint.centerHz || frame.confirmedSampleRateHz !== input.fingerprint.sampleRateHz)) return unknown("tune-mismatch");
  if (input.healthComplete === false) return unknown("receiver-unhealthy");
  const bins = new Uint8Array(binCount);
  const middle = selected.length >= 5 ? [selected[1], selected[2], selected[3]] : selected.slice(0, 3);
  for (let index = 0; index < binCount; index += 1) bins[index] = medianOfThree(middle[0].bins[index], middle[1].bins[index], middle[2].bins[index]);
  const first = selected[0];
  const last = selected.at(-1)!;
  const hasMonotonicSpan = Number.isFinite(first.receivedMonotonicMs)
    && Number.isFinite(last.receivedMonotonicMs);
  const rawExposureMs = hasMonotonicSpan
    ? last.receivedMonotonicMs! - first.receivedMonotonicMs!
    : Date.parse(last.timestamp) - Date.parse(first.timestamp);
  if (!Number.isFinite(rawExposureMs) || rawExposureMs < 0) return unknown("receiver-unhealthy");
  // Persisted baseline coverage is counted in completed milliseconds. Keep the
  // original frame timestamps for sub-millisecond evidence, but never round the
  // derived exposure up across a detector threshold.
  const exposureMs = Math.floor(rawExposureMs);
  return {
    status: "valid",
    observation: {
      dataDomain: input.fingerprint.dataDomain,
      id: randomUUID(),
      visitId: input.visitId,
      configurationEpoch: input.configurationEpoch,
      tuneEpoch: input.tuneEpoch,
      visitEpoch: input.visitEpoch,
      targetId: input.targetId,
      receiver: first.receiver,
      bandId: first.bandId,
      affectedBandIds: [...new Set(input.affectedBandIds)],
      observedAt: last.timestamp,
      firstFrameAt: first.timestamp,
      lastFrameAt: last.timestamp,
      exposureMs,
      acceptedFrameCount: selected.length,
      bins,
      confirmedCenterHz: first.confirmedCenterHz!,
      confirmedSampleRateHz: first.confirmedSampleRateHz!,
      tuneConfirmedAt: first.tuneConfirmedAt!,
      fingerprint: input.fingerprint,
      overload: input.overload ?? false,
      healthComplete: input.healthComplete ?? true,
    },
  };
}

function histogramMedian(histogram: Uint16Array, count: number): number {
  const wanted = Math.floor((Math.max(1, count) - 1) / 2);
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen > wanted) return value;
  }
  return 0;
}

function eventKind(kind: DetectionKind, band: BandPreset): DetectionKind {
  return band.service === "gnss" && kind !== "overload" ? "gnss-energy-anomaly" : kind;
}

export function analyzedFrequencyRange(observation: TargetObservation): [number, number] {
  const fingerprint = observation.fingerprint;
  const binCount = Math.max(1, fingerprint.inputBinCount);
  const startBin = Math.max(0, Math.min(binCount, fingerprint.analysisStartBin));
  const endBin = Math.max(startBin, Math.min(binCount, fingerprint.analysisEndBin));
  const captureStartHz = observation.confirmedCenterHz - observation.confirmedSampleRateHz / 2;
  const binWidthHz = observation.confirmedSampleRateHz / binCount;
  return [
    Math.round(captureStartHz + startBin * binWidthHz),
    Math.round(captureStartHz + endBin * binWidthHz),
  ];
}

export function centralAnalysisBinBounds(
  inputBinCount: number,
  analysisSpanHz: number,
  captureSpanHz: number,
): { startBin: number; endBin: number } {
  const count = Math.max(0, Math.trunc(inputBinCount));
  if (!count || !Number.isFinite(analysisSpanHz) || !Number.isFinite(captureSpanHz) || analysisSpanHz <= 0 || captureSpanHz <= 0) {
    return { startBin: 0, endBin: 0 };
  }
  const analyzedCount = Math.max(1, Math.min(count, Math.floor(count * Math.min(1, analysisSpanHz / captureSpanHz))));
  const startBin = Math.max(0, Math.floor((count - analyzedCount) / 2));
  return { startBin, endBin: Math.min(count, startBin + analyzedCount) };
}

/**
 * Projects detector-owned ranges from the native analyzed grid to the bounded
 * display grid. Adjacent projected ranges are merged so metadata stays small.
 */
export function projectDetectorAnalysisToFrame(input: {
  analysis: DetectorObservationAnalysis;
  frameBinCount: number;
  analysisStartBin: number;
  analysisEndBin: number;
}): DetectorSpectrumAnalysis {
  const frameBinCount = Math.max(0, Math.trunc(input.frameBinCount));
  const analysisStartBin = Math.max(0, Math.min(frameBinCount, Math.trunc(input.analysisStartBin)));
  const analysisEndBin = Math.max(analysisStartBin, Math.min(frameBinCount, Math.trunc(input.analysisEndBin)));
  const displaySpan = analysisEndBin - analysisStartBin;
  const sourceCount = Math.max(1, input.analysis.inputBinCount);
  const projected: DetectorAnomalyBinRange[] = [];
  for (const range of input.analysis.anomalyBinRanges) {
    const startBin = Math.max(analysisStartBin, Math.min(analysisEndBin,
      analysisStartBin + Math.floor((range.startBin / sourceCount) * displaySpan)));
    const endBin = Math.max(startBin, Math.min(analysisEndBin,
      analysisStartBin + Math.ceil((range.endBin / sourceCount) * displaySpan)));
    if (endBin <= startBin) continue;
    const previous = projected.at(-1);
    if (previous && startBin <= previous.endBin) previous.endBin = Math.max(previous.endBin, endBin);
    else projected.push({ startBin, endBin });
  }
  return {
    schemaVersion: 1,
    source: "relative-mad-detector",
    observationId: input.analysis.observationId,
    ruleSetId: input.analysis.ruleSetId,
    disposition: input.analysis.disposition,
    analyzedRangeHz: [...input.analysis.analyzedRangeHz],
    analysisStartBin,
    analysisEndBin,
    baselineAvailable: input.analysis.baselineAvailable,
    overload: input.analysis.overload,
    anomalyKind: input.analysis.anomalyKind,
    anomalyBinRanges: projected,
  };
}

export class DetectionEngine {
  private readonly states = new Map<string, BaselineState>();
  private readonly histogram = new Uint16Array(256);
  private readonly zHistogram = new Uint32Array(2_561);
  private readonly ruleFingerprint: string;

  constructor(
    private readonly thresholds: DetectionThresholds = DEFAULT_THRESHOLDS,
    private readonly random: () => number = Math.random,
  ) {
    this.ruleFingerprint = detectionRuleFingerprint(thresholds);
  }

  getBaselineStates(): BaselineDescriptor[] {
    return [...this.states.values()].map((state) => this.descriptor(state));
  }

  getAllocationBytes(): number {
    return this.histogram.byteLength + this.zHistogram.byteLength + [...this.states.values()].reduce(
      (total, state) => total
        + state.reservoir.byteLength
        + state.medians.byteLength
        + state.mads.byteLength
        + state.votes.length * 32
        + state.representativeHours.size * 48
        + 256,
      0,
    );
  }

  approve(targetId: string, fingerprintId: string): BaselineDescriptor {
    const state = this.states.get(`${targetId}:${fingerprintId}`);
    if (!state || state.lifecycle !== "reviewable") throw new Error("Baseline is not reviewable");
    state.lifecycle = "protected";
    state.protectedAt = new Date().toISOString();
    return this.descriptor(state);
  }

  restart(targetId: string, fingerprintId: string, now = Date.now()): BaselineDescriptor {
    const key = `${targetId}:${fingerprintId}`;
    const previous = this.states.get(key);
    if (!previous) throw new Error("Baseline fingerprint is not active");
    const state = this.createState(targetId, fingerprintId, previous.binCount, now, previous.dataDomain);
    this.states.set(key, state);
    return this.descriptor(state);
  }

  /** Clears every vote, adaptive row, hour bucket, and readiness flag for a target. */
  resetTarget(
    targetId: string,
    fingerprintId: string,
    dataDomain: BaselineFingerprint["dataDomain"],
    learningGenerationId: string,
    binCount: number,
    now = Date.now(),
  ): BaselineDescriptor {
    for (const [key, state] of this.states) if (state.targetId === targetId) this.states.delete(key);
    if (!Number.isSafeInteger(binCount) || binCount <= 0) throw new Error("Detector reset requires a positive analysis bin count");
    const state = this.createState(targetId, fingerprintId, binCount, now, dataDomain, learningGenerationId);
    this.states.set(`${targetId}:${fingerprintId}`, state);
    return this.descriptor(state);
  }

  analyzeObservation(observation: TargetObservation, band: BandPreset, options: {
    freezeTraining?: boolean;
    expectedVisit?: boolean;
    referenceBaseline?: DetectionBaselineReference;
    /** Production monitoring fails closed if the persistent exact reference is unavailable. */
    requireReferenceBaseline?: boolean;
  } = {}): DetectionResult {
    if (observation.dataDomain !== observation.fingerprint.dataDomain) {
      throw new Error("Observation and baseline fingerprint cross a data-domain boundary");
    }
    const fingerprintId = baselineFingerprintId(observation.fingerprint);
    const key = `${observation.targetId}:${fingerprintId}`;
    const observedAtMs = Date.parse(observation.observedAt);
    const external = options.referenceBaseline;
    const externalExact = Boolean(
      external
      && external.descriptor.dataDomain === observation.dataDomain
      && external.descriptor.targetId === observation.targetId
      && external.descriptor.fingerprintId === fingerprintId
      && external.descriptor.learningGenerationId.trim(),
    );
    const existing = this.states.get(key);
    const fallbackBaseline = existing ? this.descriptor(existing) : {
      dataDomain: observation.dataDomain,
      targetId: observation.targetId,
      lifecycle: "learning" as const,
      fingerprintId,
      learningGenerationId: "uninitialized",
      observationCount: 0,
      validCoverageRatio: 0,
      representativeHours: 0,
      learningStartedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : new Date(0).toISOString(),
      reason: "Collecting at least 30 minutes and sufficient valid visits.",
    };
    const unknown = (
      reason: NonNullable<DetectionResult["unknownReason"]>,
      baseline: BaselineDescriptor = externalExact ? external!.descriptor : fallbackBaseline,
    ): DetectionResult => ({
      disposition: "unknown",
      metrics: this.learningMetrics(observation),
      baseline,
      alertEligible: false,
      trainingEligible: false,
      unknownReason: reason,
      analysis: this.observationAnalysis(observation, undefined, "unknown", baseline, undefined),
    });
    const fingerprint = observation.fingerprint;
    const expectedAnalysisBins = fingerprint.analysisEndBin - fingerprint.analysisStartBin;
    const eligible = observation.targetId === fingerprint.targetId
      && fingerprint.receiverIdentity.trim().length > 0
      && fingerprint.detectionRuleHash === this.ruleFingerprint
      && Number.isFinite(observedAtMs)
      && Number.isFinite(Date.parse(observation.firstFrameAt))
      && Number.isFinite(Date.parse(observation.lastFrameAt))
      && Number.isFinite(Date.parse(observation.tuneConfirmedAt))
      && observation.acceptedFrameCount >= 3
      && observation.bins.length > 0
      && expectedAnalysisBins === observation.bins.length
      && observation.confirmedCenterHz === fingerprint.centerHz
      && observation.confirmedSampleRateHz === fingerprint.sampleRateHz
      && Number.isFinite(observation.exposureMs)
      && observation.exposureMs >= 0
      && observation.healthComplete;
    if (!eligible) return unknown("observation-ineligible");
    if (options.requireReferenceBaseline && !external) return unknown("baseline-unavailable");
    if (external && !externalExact) return unknown("baseline-mismatch");

    let state = this.states.get(key);
    const authoritativeGeneration = externalExact ? external!.descriptor.learningGenerationId : undefined;
    if (!state
      || state.binCount !== observation.bins.length
      || (authoritativeGeneration !== undefined && state.learningGenerationId !== authoritativeGeneration)) {
      for (const [candidateKey, candidate] of this.states) {
        if (candidate.targetId === observation.targetId) this.states.delete(candidateKey);
      }
      if (this.states.size >= MAX_DETECTOR_STATES) {
        const oldest = [...this.states.entries()].sort((left, right) => left[1].lastObservedAtMs - right[1].lastObservedAtMs)[0];
        if (oldest) this.states.delete(oldest[0]);
      }
      state = this.createState(
        observation.targetId,
        fingerprintId,
        observation.bins.length,
        observedAtMs,
        observation.dataDomain,
        authoritativeGeneration,
      );
      this.states.set(key, state);
    }
    if (externalExact && state.lifecycle !== external!.descriptor.lifecycle) {
      // Lifecycle changes are trust-boundary changes. Cold-start candidate
      // votes must not become approval-generation evidence later.
      state.votes = [];
      state.driftExposureMs = 0;
      state.lastDriftAtMs = undefined;
      state.lifecycle = external!.descriptor.lifecycle;
      state.protectedAt = external!.descriptor.protectedAt;
    }
    state.lastObservedAtMs = observedAtMs;
    if (!externalExact) {
      state.expectedVisits += options.expectedVisit === false ? 0 : 1;
      state.validVisits += 1;
      this.updateHourBucket(state, observation, options);
    }
    const externalUsable = Boolean(
      externalExact
      && external!.descriptor.lifecycle !== "stale"
      && external!.descriptor.observationCount >= MIN_BOOTSTRAP_REFERENCE_OBSERVATIONS
      && external!.medians.length === observation.bins.length
      && external!.mads.length === observation.bins.length,
    );

    if (externalExact && !externalUsable && !observation.overload) {
      const baseline = external!.descriptor;
      const trainingEligible = !options.freezeTraining;
      return {
        disposition: "unknown",
        metrics: this.learningMetrics(observation),
        baseline,
        alertEligible: false,
        trainingEligible,
        analysis: this.observationAnalysis(observation, undefined, "unknown", baseline, undefined),
      };
    }

    if (state.reservoirCount < MIN_BASELINE_OBSERVATIONS && !externalUsable && !observation.overload) {
      const trainable = !observation.overload && observation.healthComplete && !options.freezeTraining;
      let trainingEligible = false;
      let metrics = this.learningMetrics(observation);
      if (trainable && state.reservoirCount < MIN_BOOTSTRAP_REFERENCE_OBSERVATIONS) {
        // A bounded bootstrap is unavoidable without an approved reference.
        // Eight rows provide a median which tolerates up to four early high
        // outliers; the documented commissioning procedure must still begin in
        // a known-quiet environment.
        // Bootstrap rows are retained only in this process. They establish the
        // comparison gate but are not asserted as clean or admitted to the
        // persistent commissioning baseline.
        this.addReservoirObservation(state, observation.bins);
      } else if (trainable) {
        this.deriveRobustBaseline(state);
        const features = this.features(observation, state);
        metrics = this.metrics(observation, state, features);
        trainingEligible = this.classify(features, observation.overload) === undefined;
        if (!trainingEligible) this.invalidateHourBucket(state, observation);
      }
      if (trainingEligible) this.addReservoirObservation(state, observation.bins);
      this.promoteLifecycle(state, observedAtMs);
      const baseline = this.descriptor(state);
      return {
        disposition: "unknown",
        metrics,
        baseline,
        alertEligible: false,
        trainingEligible,
        analysis: this.observationAnalysis(observation, undefined, "unknown", baseline, undefined),
      };
    }

    if (!externalUsable || state.reservoirCount >= MIN_BASELINE_OBSERVATIONS) this.deriveRobustBaseline(state);
    const externalState = externalUsable ? {
      ...state,
      lifecycle: external!.descriptor.lifecycle,
      learningGenerationId: external!.descriptor.learningGenerationId,
      medians: external!.medians,
      mads: external!.mads,
    } : undefined;
    const useOperationalReference = externalUsable
      && external!.descriptor.lifecycle === "protected"
      && state.reservoirCount >= MIN_BASELINE_OBSERVATIONS;
    const referenceState = useOperationalReference ? state : externalState ?? state;
    const features = this.features(observation, referenceState);
    const protectedMedianZ = externalState?.lifecycle === "protected"
      ? this.features(observation, externalState).medianZ
      : undefined;
    const kind = this.classify(features, observation.overload, protectedMedianZ);
    if (kind) this.invalidateHourBucket(state, observation);
    if (state.votes.at(-1) && observedAtMs - state.votes.at(-1)!.observedAtMs > MAX_CANDIDATE_GAP_MS) state.votes = [];
    state.votes.push({ kind, exposureMs: observation.exposureMs, observedAtMs });
    state.votes = state.votes.slice(-this.thresholds.interferenceWindow);
    const matchingVotes = kind ? state.votes.filter((vote) => vote.kind === kind) : [];
    if (kind === "baseline-drift") {
      if (state.lastDriftAtMs === undefined || observedAtMs - state.lastDriftAtMs > MAX_CANDIDATE_GAP_MS) state.driftExposureMs = 0;
      state.driftExposureMs = Math.min(this.thresholds.driftExposureMs, state.driftExposureMs + observation.exposureMs);
      state.lastDriftAtMs = observedAtMs;
    } else {
      state.driftExposureMs = 0;
      state.lastDriftAtMs = undefined;
    }
    const exposureMs = kind === "baseline-drift"
      ? state.driftExposureMs
      : matchingVotes.reduce((total, vote) => total + vote.exposureMs, 0);
    const alertEligible = kind === "overload"
      ? true
      : kind === "baseline-drift"
        ? exposureMs >= this.thresholds.driftExposureMs
        : kind === "narrowband-spike"
          ? matchingVotes.length >= this.thresholds.interferenceHits
          : matchingVotes.length >= this.thresholds.interferenceHits && exposureMs >= this.thresholds.interferenceExposureMs;

    const trainingEligible = !kind && !observation.overload && !options.freezeTraining;
    if (trainingEligible && (!externalExact || external!.descriptor.lifecycle === "protected")) {
      this.addReservoirObservation(state, observation.bins);
    }
    if (!externalExact) this.promoteLifecycle(state, observedAtMs);
    const metrics = this.metrics(observation, referenceState, features);
    const baseline = externalExact ? external!.descriptor : this.descriptor(state);
    const disposition: ObservationDisposition = kind ? "anomalous" : "clean";
    const candidate = kind ? {
      kind,
      hits: matchingVotes.length,
      window: this.thresholds.interferenceWindow,
      observedExposureMs: exposureMs,
      count: matchingVotes.length,
      required: kind === "overload" ? 1 : this.thresholds.interferenceHits,
    } : undefined;
    if (externalExact && baseline.lifecycle === "learning" && kind !== "overload") {
      // A robust seed may quarantine a change during Learning, but it cannot
      // claim a clean/anomalous operational observation or draw red anomaly
      // regions before the persistent baseline becomes Provisional.
      return {
        disposition: "unknown",
        metrics,
        baseline,
        candidate,
        alertEligible: false,
        trainingEligible,
        analysis: this.observationAnalysis(observation, undefined, "unknown", baseline, undefined),
      };
    }
    const analysis = this.observationAnalysis(observation, kind, disposition, baseline, referenceState);
    if (!kind || !alertEligible) return { disposition, metrics, baseline, candidate, alertEligible, trainingEligible, analysis };

    const evidenceStrength = baseline.lifecycle === "protected" && observation.healthComplete ? "Medium" as const : "Low" as const;
    return {
      disposition,
      metrics,
      baseline,
      candidate,
      alertEligible,
      trainingEligible,
      analysis,
      event: {
        dataDomain: observation.dataDomain,
        kind: eventKind(kind, band),
        status: kind === "baseline-drift" || kind === "overload" ? "suspicious" : "interference-likely",
        severity: evidenceStrength === "Medium" ? "medium" : "low",
        evidenceStrength,
        evidenceBasis: baseline.lifecycle === "protected"
          ? "Repeated relative RF anomaly against an approved exact-configuration baseline."
          : "Relative RF anomaly from an unapproved or provisional baseline.",
        baselineId: baseline.lifecycle === "protected" ? baseline.baselineId : undefined,
        baselineFingerprintId: fingerprintId,
        ruleSetId: this.thresholds.ruleSetId,
        observationId: observation.id,
        service: band.service,
        bandId: band.id,
        targetId: observation.targetId,
        scanWindowId: observation.visitId,
        bandLabel: band.label,
        affectedBandIds: observation.affectedBandIds,
        affectedRangeHz: analyzedFrequencyRange(observation),
        observed: this.describe(kind, band.service === "gnss"),
        recommendedAction: band.service === "gnss"
          ? "Check position and time on an independent receiver. Keep recording."
          : "Use the approved backup channel if available. Keep recording.",
        startedAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
        metrics,
      },
    };
  }

  private createState(
    targetId: string,
    fingerprintId: string,
    binCount: number,
    now: number,
    dataDomain: BaselineFingerprint["dataDomain"],
    learningGenerationId: string = randomUUID(),
  ): BaselineState {
    return {
      dataDomain,
      targetId,
      fingerprintId,
      learningGenerationId,
      lifecycle: "learning",
      learningStartedAtMs: now,
      observationsSeen: 0,
      validVisits: 0,
      expectedVisits: 0,
      reservoirCount: 0,
      reservoir: new Uint8Array(this.thresholds.reservoirSize * binCount),
      binCount,
      medians: new Uint8Array(binCount),
      mads: new Uint8Array(binCount),
      reservoirRevision: 0,
      derivedRevision: -1,
      representativeHours: new Map(),
      votes: [],
      driftExposureMs: 0,
      lastObservedAtMs: now,
    };
  }

  private addReservoirObservation(state: BaselineState, bins: Uint8Array): void {
    state.observationsSeen += 1;
    let slot = state.reservoirCount;
    if (state.reservoirCount < this.thresholds.reservoirSize) state.reservoirCount += 1;
    else {
      const candidate = Math.floor(this.random() * state.observationsSeen);
      if (candidate >= this.thresholds.reservoirSize) return;
      slot = candidate;
    }
    state.reservoir.set(bins, slot * state.binCount);
    state.reservoirRevision += 1;
  }

  /**
   * Per-bin median and MAD of the reservoir. They are a pure function of the reservoir, which
   * changes only on a write (every row while it fills, then with probability size/observationsSeen),
   * so unchanged reservoirs skip the roughly two-million-operation recompute.
   */
  private deriveRobustBaseline(state: BaselineState): void {
    if (state.derivedRevision === state.reservoirRevision) return;
    state.derivedRevision = state.reservoirRevision;
    for (let bin = 0; bin < state.binCount; bin += 1) {
      this.histogram.fill(0);
      for (let row = 0; row < state.reservoirCount; row += 1) this.histogram[state.reservoir[row * state.binCount + bin]] += 1;
      const median = histogramMedian(this.histogram, state.reservoirCount);
      state.medians[bin] = median;
      this.histogram.fill(0);
      for (let row = 0; row < state.reservoirCount; row += 1) this.histogram[Math.abs(state.reservoir[row * state.binCount + bin] - median)] += 1;
      state.mads[bin] = histogramMedian(this.histogram, state.reservoirCount);
    }
  }

  private features(observation: TargetObservation, state: BaselineState): { medianZ: number; peakZ: number; occupied6: number; occupied8: number; maxWidthRatio: number; mean: number; peak: number; baselineMean: number } {
    this.zHistogram.fill(0);
    let peakZ = 0;
    let occupied6 = 0;
    let occupied8 = 0;
    let currentRun = 0;
    let maximumRun = 0;
    let total = 0;
    let baselineTotal = 0;
    let peak = 0;
    for (let index = 0; index < observation.bins.length; index += 1) {
      const value = observation.bins[index];
      const baseline = state.medians[index];
      const scale = Math.max(1.4826 * state.mads[index], this.thresholds.scaleFloorBins);
      const z = Math.max(0, (value - baseline) / scale);
      this.zHistogram[Math.min(this.zHistogram.length - 1, Math.round(z * 10))] += 1;
      peakZ = Math.max(peakZ, z);
      if (z >= this.thresholds.widebandObservationSigma) {
        occupied6 += 1;
        currentRun += 1;
        maximumRun = Math.max(maximumRun, currentRun);
      } else currentRun = 0;
      if (z >= this.thresholds.interferenceSigma) occupied8 += 1;
      total += value;
      baselineTotal += baseline;
      peak = Math.max(peak, value);
    }
    const wanted = Math.floor((observation.bins.length - 1) / 2);
    let seen = 0;
    let medianBucket = 0;
    for (let index = 0; index < this.zHistogram.length; index += 1) {
      seen += this.zHistogram[index];
      if (seen > wanted) { medianBucket = index; break; }
    }
    const count = Math.max(1, observation.bins.length);
    return {
      medianZ: medianBucket / 10,
      peakZ,
      occupied6: occupied6 / count,
      occupied8: occupied8 / count,
      maxWidthRatio: maximumRun / count,
      mean: total / count,
      peak,
      baselineMean: baselineTotal / count,
    };
  }

  private classify(features: ReturnType<DetectionEngine["features"]>, overload: boolean, protectedMedianZ?: number): DetectionKind | undefined {
    if (overload) return "overload";
    if (features.medianZ >= this.thresholds.interferenceSigma && features.occupied8 >= this.thresholds.interferenceOccupancy) return "wideband-noise-rise";
    if (features.medianZ >= this.thresholds.widebandObservationSigma && features.occupied6 >= this.thresholds.widebandObservationOccupancy) return "wideband-noise-rise";
    if (features.peakZ >= this.thresholds.narrowbandPeakSigma && features.maxWidthRatio > 0 && features.maxWidthRatio <= this.thresholds.narrowbandMaxWidthRatio) return "narrowband-spike";
    if (protectedMedianZ !== undefined && protectedMedianZ >= this.thresholds.driftSigma) return "baseline-drift";
    return undefined;
  }

  private observationAnalysis(
    observation: TargetObservation,
    kind: DetectionKind | undefined,
    disposition: ObservationDisposition,
    baseline: BaselineDescriptor,
    referenceState: Pick<BaselineState, "medians" | "mads"> | undefined,
  ): DetectorObservationAnalysis {
    const anomalyBinRanges: DetectorAnomalyBinRange[] = [];
    if (kind && kind !== "overload" && referenceState) {
      const threshold = kind === "narrowband-spike"
        ? this.thresholds.narrowbandPeakSigma
        : kind === "baseline-drift"
          ? this.thresholds.driftSigma
          : this.thresholds.widebandObservationSigma;
      let startBin: number | undefined;
      for (let index = 0; index <= observation.bins.length; index += 1) {
        const baselineValue = referenceState.medians[index] ?? 0;
        const mad = referenceState.mads[index] ?? 0;
        const z = index < observation.bins.length
          ? Math.max(0, (observation.bins[index] - baselineValue) / Math.max(1.4826 * mad, this.thresholds.scaleFloorBins))
          : -Infinity;
        if (z >= threshold) {
          startBin ??= index;
        } else if (startBin !== undefined) {
          anomalyBinRanges.push({ startBin, endBin: index });
          startBin = undefined;
        }
      }
    }
    const anomalyKind = kind && kind !== "overload" && kind !== "gnss-energy-anomaly" ? kind : undefined;
    return {
      observationId: observation.id,
      ruleSetId: this.thresholds.ruleSetId,
      disposition,
      analyzedRangeHz: analyzedFrequencyRange(observation),
      inputBinCount: observation.bins.length,
      baselineAvailable: baseline.lifecycle !== "learning" && baseline.lifecycle !== "stale" && Boolean(referenceState),
      overload: kind === "overload" || observation.overload,
      ...(anomalyKind ? { anomalyKind } : {}),
      anomalyBinRanges,
    };
  }

  private metrics(observation: TargetObservation, state: BaselineState, features: ReturnType<DetectionEngine["features"]>): SignalMetricSample {
    return {
      timestamp: observation.observedAt,
      bandId: observation.bandId,
      meanLevel: Number(features.mean.toFixed(2)),
      peakLevel: features.peak,
      baselineLevel: Number(features.baselineMean.toFixed(2)),
      baselineDelta: Number((features.mean - features.baselineMean).toFixed(2)),
      occupiedRatio: Number(features.occupied6.toFixed(4)),
      overload: observation.overload,
      medianRobustZ: Number(features.medianZ.toFixed(2)),
      peakRobustZ: Number(features.peakZ.toFixed(2)),
      maximumOccupiedWidthRatio: Number(features.maxWidthRatio.toFixed(4)),
    };
  }

  private learningMetrics(observation: TargetObservation): SignalMetricSample {
    let total = 0;
    let peak = 0;
    for (const value of observation.bins) { total += value; peak = Math.max(peak, value); }
    const mean = observation.bins.length ? total / observation.bins.length : 0;
    return {
      timestamp: observation.observedAt,
      bandId: observation.bandId,
      meanLevel: Number(mean.toFixed(2)),
      peakLevel: peak,
      baselineLevel: Number(mean.toFixed(2)),
      baselineDelta: 0,
      occupiedRatio: 0,
      overload: observation.overload,
    };
  }

  private updateHourBucket(state: BaselineState, observation: TargetObservation, options: { freezeTraining?: boolean; expectedVisit?: boolean }): void {
    const hour = observation.observedAt.slice(0, 13);
    const bucket = state.representativeHours.get(hour) ?? { valid: 0, expected: 0, eligible: true };
    bucket.expected += options.expectedVisit === false ? 0 : 1;
    bucket.valid += 1;
    bucket.eligible &&= observation.healthComplete && !observation.overload && !options.freezeTraining;
    state.representativeHours.set(hour, bucket);
    while (state.representativeHours.size > MAX_HOUR_BUCKETS) state.representativeHours.delete(state.representativeHours.keys().next().value!);
  }

  private invalidateHourBucket(state: BaselineState, observation: TargetObservation): void {
    const bucket = state.representativeHours.get(observation.observedAt.slice(0, 13));
    if (bucket) bucket.eligible = false;
  }

  private promoteLifecycle(state: BaselineState, observedAtMs: number): void {
    const coverage = state.expectedVisits ? state.validVisits / state.expectedVisits : 0;
    if (state.lifecycle === "learning" && observedAtMs - state.learningStartedAtMs >= this.thresholds.minimumLearningMs && state.reservoirCount >= MIN_BASELINE_OBSERVATIONS && coverage >= 0.8) state.lifecycle = "provisional";
    const representative = [...state.representativeHours.values()].filter((bucket) => bucket.eligible && bucket.expected > 0 && bucket.valid / bucket.expected >= 0.8).length;
    if (state.lifecycle === "provisional" && representative >= REPRESENTATIVE_HOURS) state.lifecycle = "reviewable";
  }

  private descriptor(state: BaselineState): BaselineDescriptor {
    const representativeHours = [...state.representativeHours.values()].filter((bucket) => bucket.eligible && bucket.expected > 0 && bucket.valid / bucket.expected >= 0.8).length;
    return {
      dataDomain: state.dataDomain,
      targetId: state.targetId,
      lifecycle: state.lifecycle,
      fingerprintId: state.fingerprintId,
      baselineId: state.lifecycle === "protected" ? `${state.fingerprintId}:${state.learningGenerationId}` : undefined,
      learningGenerationId: state.learningGenerationId,
      observationCount: state.reservoirCount,
      validCoverageRatio: state.expectedVisits ? state.validVisits / state.expectedVisits : 0,
      representativeHours,
      learningStartedAt: new Date(state.learningStartedAtMs).toISOString(),
      protectedAt: state.protectedAt,
      reason: state.lifecycle === "learning" ? "Collecting at least 30 minutes and sufficient valid visits." : undefined,
    };
  }

  private describe(kind: DetectionKind, gnss: boolean): string {
    if (kind === "overload") return "Receiver input is overloaded. Readings may be wrong.";
    if (kind === "narrowband-spike") return "Moving or stationary narrowband energy stayed above its usual level.";
    if (kind === "baseline-drift") return "The relative signal level drifted above the approved baseline.";
    if (gnss) return "Relative RF energy stayed above normal across this navigation frequency. RF data can show interference, not intent.";
    return "Relative RF energy rose across much of this monitored section.";
  }
}
