import { createHash, randomUUID } from "node:crypto";
import {
  ALERT_CLASSIFIER_VERSION,
  ALERT_PRESET_IDS,
  ALERT_PRESET_TABLE_VERSION,
  alertPresetValues,
  alertVoteGapMs,
  analysisKindFor,
  binRangesToHz,
  burstFromFrame,
  classifyAlert,
  createAlertTrackerState,
  deriveAlertingFromDetection,
  publicDetectionKind,
  referenceKind,
  segmentFeatures,
  updateAlertTracker,
  type AlertSegment,
  type AlertTrackerState,
  type EmissionKind,
} from "./alertPolicy";
import type {
  AlertDetailKind,
  AlertingSettings,
  AlertPolicyChoice,
  AlertPolicyValues,
  AlertPresetId,
  AlertRuleComparison,
  AlertTrigger,
  AlertTriggerSnapshot,
  BandPreset,
  BaselineDescriptor,
  BaselineFingerprint,
  DetectorAnomalyBinRange,
  DetectorSpectrumAnalysis,
  DetectionEvent,
  DetectionKind,
  DetectionRuleSettings,
  DetectorGauge,
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
  /** Alert-track persistence; independent of the learning-track votes above. */
  alert: AlertTrackerState;
  /** Shadow trackers per preset for the sensitivity preview (estimates only). */
  shadow?: ShadowPreviewState;
}

interface ShadowPreviewState {
  firstAtMs: number;
  trackers: Record<AlertPresetId, AlertTrackerState>;
  onsets: Record<AlertPresetId, number[]>;
  activeOnsets: number[];
}

const PREVIEW_WINDOW_MS = 24 * 60 * 60_000;
const MAX_PREVIEW_ONSETS = 512;
const MAX_TRIGGER_SNAPSHOT_BINS = 4_096;

export interface ResolvedAlertPolicyWithHash {
  choice: AlertPolicyChoice;
  source: "default" | "window";
  values: AlertPolicyValues;
  hash: string;
}

export function alertPolicyHash(values: AlertPolicyValues): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    classifierVersion: ALERT_CLASSIFIER_VERSION,
    presetTableVersion: ALERT_PRESET_TABLE_VERSION,
    values,
  }))).digest("hex");
}

/** Hash of every resolved alert policy; binds qualification records to exact alert behaviour. */
export function alertingSettingsHash(alerting: AlertingSettings): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    classifierVersion: ALERT_CLASSIFIER_VERSION,
    presetTableVersion: alerting.presetTableVersion,
    default: alerting.default.values,
    targetOverrides: Object.fromEntries(Object.entries(alerting.targetOverrides ?? {}).map(([id, setting]) => [id, setting.values])),
  }))).digest("hex");
}

export function withAlertPolicyHash(policy: { choice: AlertPolicyChoice; source: "default" | "window"; values: AlertPolicyValues }): ResolvedAlertPolicyWithHash {
  return { ...policy, hash: alertPolicyHash(policy.values) };
}

export interface DetectionCandidate {
  kind: DetectionKind;
  detailKind?: AlertDetailKind;
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
  /** Engineer-only margins against every alert rule for this check. */
  gauge?: DetectorGauge;
  /** The usual-level arrays this check was compared with (for the live reference view). */
  reference?: DetectionReferenceView;
  /** Exact detector view for the evidence record; built only when an incident is first created. */
  triggerSnapshot?: (eventId: string) => AlertTriggerSnapshot;
}

export interface DetectionReferenceView {
  revision: string;
  medians: Uint8Array;
  mads: Uint8Array;
  scaleFloorBins: number;
  alertSigma: number;
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
  anomalyDetailKind?: AlertDetailKind;
  referenceRevision?: string;
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
    ...(input.analysis.anomalyDetailKind ? { anomalyDetailKind: input.analysis.anomalyDetailKind } : {}),
    ...(input.analysis.referenceRevision ? { referenceRevision: input.analysis.referenceRevision } : {}),
    anomalyBinRanges: projected,
  };
}

export class DetectionEngine {
  private readonly states = new Map<string, BaselineState>();
  private readonly histogram = new Uint16Array(256);
  private readonly zHistogram = new Uint32Array(2_561);
  private readonly ruleFingerprint: string;
  private readonly defaultAlertPolicy: ResolvedAlertPolicyWithHash;
  private readonly presetPolicies: Array<{ id: AlertPresetId; values: AlertPolicyValues; hash: string }>;
  private zScratch = new Float32Array(0);
  private frameZScratch = new Float32Array(0);

  constructor(
    private readonly thresholds: DetectionThresholds = DEFAULT_THRESHOLDS,
    private readonly random: () => number = Math.random,
  ) {
    this.ruleFingerprint = detectionRuleFingerprint(thresholds);
    const derived = deriveAlertingFromDetection(thresholds, DEFAULT_THRESHOLDS).default;
    this.defaultAlertPolicy = withAlertPolicyHash({ choice: derived.preset, source: "default", values: derived.values });
    this.presetPolicies = ALERT_PRESET_IDS.map((id) => {
      const values = alertPresetValues(id);
      return { id, values, hash: alertPolicyHash(values) };
    });
  }

  /** Bounded live estimate: alert onsets each preset would have raised for a target. */
  getAlertPreview(targetId: string, nowMs = Date.now()): { observedHours: number; onsets: Record<AlertPresetId, number>; activeOnsets: number } | undefined {
    const state = [...this.states.values()].find((candidate) => candidate.targetId === targetId);
    const shadow = state?.shadow;
    if (!shadow) return undefined;
    const since = nowMs - PREVIEW_WINDOW_MS;
    const count = (values: number[]) => values.filter((at) => at >= since).length;
    return {
      observedHours: Math.min(24, Math.max(0, (nowMs - Math.max(shadow.firstAtMs, since)) / 3_600_000)),
      onsets: Object.fromEntries(ALERT_PRESET_IDS.map((id) => [id, count(shadow.onsets[id])])) as Record<AlertPresetId, number>,
      activeOnsets: count(shadow.activeOnsets),
    };
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
    /**
     * While a local reference is still being learned, a non-alerting,
     * non-overload candidate is treated as part of the site's conditions and
     * may be trained on. Alerts, overload and protected baselines are unaffected.
     */
    acceptCandidates?: boolean;
    /** Alert sensitivity for this target. Defaults to the policy implied by the learning rules. */
    alertPolicy?: ResolvedAlertPolicyWithHash;
    /** Repeated checks further apart than this do not count together. */
    voteGapMs?: number;
    /** Single accepted frames of this visit (analysis bins only); used only for short-burst checks. */
    frameBins?: Uint8Array[];
    /** Run the four preset shadow trackers that feed the sensitivity preview. */
    shadowPreview?: boolean;
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
        const bootstrapKind = this.classify(features, observation.overload);
        trainingEligible = bootstrapKind === undefined || (Boolean(options.acceptCandidates) && bootstrapKind !== "overload");
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
    const protectedMedianZ = externalState?.lifecycle === "protected"
      ? this.features(observation, externalState).medianZ
      : undefined;
    // The reference features fill the shared z vector used by both tracks.
    const features = this.features(observation, referenceState, true);

    // ---- Learning track (unchanged; alone decides training admission) ----
    const kind = this.classify(features, observation.overload, protectedMedianZ);
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
    const learningExposureMs = kind === "baseline-drift"
      ? state.driftExposureMs
      : matchingVotes.reduce((total, vote) => total + vote.exposureMs, 0);
    const learningAlertEligible = kind === "overload"
      ? true
      : kind === "baseline-drift"
        ? learningExposureMs >= this.thresholds.driftExposureMs
        : kind === "narrowband-spike"
          ? matchingVotes.length >= this.thresholds.interferenceHits
          : matchingVotes.length >= this.thresholds.interferenceHits && learningExposureMs >= this.thresholds.interferenceExposureMs;
    const acceptedCandidate = Boolean(options.acceptCandidates) && kind !== undefined && kind !== "overload" && !learningAlertEligible;
    if (kind && !acceptedCandidate) this.invalidateHourBucket(state, observation);
    const trainingEligible = (!kind || acceptedCandidate) && !observation.overload && !options.freezeTraining;

    // ---- Alert track (operator sensitivity; never changes what is learned) ----
    const policy = options.alertPolicy ?? this.defaultAlertPolicy;
    const values = policy.values;
    const binCount = observation.bins.length;
    const referenceLifecycle = externalExact ? external!.descriptor.lifecycle : state.lifecycle;
    const floorAllowed = referenceLifecycle !== "learning"
      && referenceLifecycle !== "stale"
      && (!values.noiseFloorRequiresProtected || referenceLifecycle === "protected");
    const floorMedianZ = protectedMedianZ ?? features.medianZ;
    const segments = segmentFeatures(this.zScratch, binCount, values.segmentSigma, values.segmentGapRatio, features.medianZ);
    const classification = classifyAlert(segments, values, { floorMedianZ, floorAllowed });
    let emission: EmissionKind | undefined = observation.overload ? undefined : classification.emission;
    let burstSegments: AlertSegment[] = [];
    let burstPeakZ: number | undefined;
    const frameZ = !observation.overload && values.burstSigma > 0 ? this.frameZVectors(options.frameBins, referenceState, binCount) : [];
    if (!observation.overload && !emission && values.burstSigma > 0) {
      for (const z of frameZ) {
        const frameFeatures = segmentFeatures(z, binCount, values.burstSigma, values.segmentGapRatio, 0);
        burstPeakZ = Math.max(burstPeakZ ?? 0, frameFeatures.peakZ);
        if (burstFromFrame(frameFeatures, values)) {
          emission = "burst";
          burstSegments = frameFeatures.segments.filter((segment) => segment.medianZ >= values.burstSigma);
          break;
        }
      }
    }
    const voteGapMs = options.voteGapMs ?? alertVoteGapMs(undefined);
    const tracker = observation.overload ? undefined : updateAlertTracker(state.alert, {
      atMs: observedAtMs,
      emission,
      floor: classification.floor,
      exposureMs: observation.exposureMs,
      values,
      voteGapMs,
      policyHash: policy.hash,
    });
    const candidateDetail: AlertDetailKind | undefined = observation.overload ? "overload" : tracker!.candidateKind;
    const alertDetail: AlertDetailKind | undefined = observation.overload ? "overload" : tracker!.alertKind;
    const alertEligible = alertDetail !== undefined;
    const alertsPossible = !(externalExact && referenceLifecycle === "learning");
    if (options.shadowPreview && alertsPossible && !observation.overload) {
      this.updateShadowPreview(state, observedAtMs, observation.exposureMs, binCount, floorMedianZ, referenceLifecycle, frameZ, voteGapMs, Boolean(tracker?.onset));
    }

    // In-memory adaptive reference: admit only checks clean under both tracks.
    if (trainingEligible && !candidateDetail && (!externalExact || external!.descriptor.lifecycle === "protected")) {
      this.addReservoirObservation(state, observation.bins);
    }
    if (!externalExact) this.promoteLifecycle(state, observedAtMs);
    const metrics = this.metrics(observation, referenceState, features);
    const baseline = externalExact ? external!.descriptor : this.descriptor(state);
    const disposition: ObservationDisposition = candidateDetail ? "anomalous" : "clean";
    const floorProgress = tracker && candidateDetail === "noise-floor"
      ? {
        hits: Math.max(1, Math.round(tracker.floorExposureMs / Math.max(1, observation.exposureMs))),
        required: Math.max(1, Math.ceil(tracker.floorRequiredMs / Math.max(1, observation.exposureMs))),
      }
      : undefined;
    const candidate: DetectionCandidate | undefined = candidateDetail ? {
      kind: publicDetectionKind(candidateDetail, band.service),
      detailKind: candidateDetail,
      hits: observation.overload ? 1 : floorProgress?.hits ?? tracker!.votes,
      window: values.alertWindow,
      observedExposureMs: observation.overload ? observation.exposureMs : candidateDetail === "noise-floor" ? tracker!.floorExposureMs : tracker!.exposureMs,
      count: observation.overload ? 1 : floorProgress?.hits ?? tracker!.votes,
      required: observation.overload ? 1 : floorProgress?.required ?? values.alertVisits,
    } : undefined;
    const referenceRevision = referenceState === state
      ? `memory:${state.learningGenerationId}:${state.derivedRevision}`
      : `stored:${external!.descriptor.fingerprintId.slice(0, 16)}:${external!.descriptor.learningGenerationId}:${external!.descriptor.observationCount}`;
    const reference: DetectionReferenceView = {
      revision: referenceRevision,
      medians: referenceState.medians,
      mads: referenceState.mads,
      scaleFloorBins: this.thresholds.scaleFloorBins,
      alertSigma: values.segmentSigma,
    };
    const persistenceRule: AlertRuleComparison = {
      rule: "persistence",
      label: "Raised checks",
      measured: tracker?.votes ?? 0,
      threshold: values.alertVisits,
      unit: "checks",
      met: Boolean(tracker && tracker.votes >= values.alertVisits && tracker.exposureMs >= values.minExposureMs),
    };
    const ruleComparisons: AlertRuleComparison[] = [
      ...classification.rules,
      ...(values.burstSigma > 0 ? [{
        rule: "burst" as const,
        label: "Short-burst strength",
        measured: Math.round((burstPeakZ ?? 0) * 100) / 100,
        threshold: values.burstSigma,
        unit: "x" as const,
        met: emission === "burst",
      }] : []),
      persistenceRule,
    ];
    const gauge: DetectorGauge = {
      observedAt: observation.observedAt,
      preset: policy.choice,
      rules: ruleComparisons,
      votes: tracker?.votes ?? 0,
      required: values.alertVisits,
      window: values.alertWindow,
      exposureMs: tracker?.exposureMs ?? 0,
      requiredExposureMs: values.minExposureMs,
      floorExposureMs: tracker?.floorExposureMs ?? 0,
      floorRequiredMs: values.noiseFloorExposureMs,
    };
    const rangeSegments: Array<{ startBin: number; endBin: number }> = !candidateDetail || candidateDetail === "overload"
      ? []
      : candidateDetail === "burst"
        ? burstSegments
        : candidateDetail === "noise-floor"
          ? segmentFeatures(this.zScratch, binCount, values.noiseFloorSigma, values.segmentGapRatio, features.medianZ).segments
          : classification.qualifying;
    const anomalyBinRanges = rangeSegments.map((segment) => ({ startBin: segment.startBin, endBin: segment.endBin }));
    if (externalExact && baseline.lifecycle === "learning" && !observation.overload) {
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
        analysis: this.observationAnalysis(observation, undefined, "unknown", baseline, undefined, [], referenceRevision),
        gauge,
        reference,
      };
    }
    const analysis = this.observationAnalysis(observation, candidateDetail, disposition, baseline, referenceState, anomalyBinRanges, referenceRevision);
    if (!candidateDetail || !alertEligible) return { disposition, metrics, baseline, candidate, alertEligible, trainingEligible, analysis, gauge, reference };

    const detail = alertDetail!;
    const evidenceStrength = baseline.lifecycle === "protected" && observation.healthComplete ? "Medium" as const : "Low" as const;
    const analyzedRangeHz = analyzedFrequencyRange(observation);
    const binWidthHz = binCount ? (analyzedRangeHz[1] - analyzedRangeHz[0]) / binCount : 0;
    const disturbedRangesHz = binRangesToHz(anomalyBinRanges, analyzedRangeHz, binCount);
    const peakBin = segments.peakBin;
    const usualAtPeak = referenceState.medians[peakBin] ?? 0;
    const levelAtPeak = observation.bins[peakBin] ?? 0;
    const trigger: AlertTrigger = {
      schemaVersion: 1,
      classifierVersion: ALERT_CLASSIFIER_VERSION,
      detailKind: detail,
      firedAt: observation.observedAt,
      observationId: observation.id,
      policy: { choice: policy.choice, source: policy.source, values: { ...values }, hash: policy.hash },
      reference: {
        lifecycle: baseline.lifecycle,
        kind: referenceKind(baseline.lifecycle),
        fingerprintId,
        generationId: baseline.learningGenerationId,
        revision: referenceRevision,
      },
      measured: {
        peakZ: round2(segments.peakZ),
        medianZ: round2(floorMedianZ),
        occupancyRatio: Math.round(segments.occupancy * 10_000) / 10_000,
        widestSegmentRatio: Math.round(segments.widestSegmentRatio * 10_000) / 10_000,
        widestSegmentMedianZ: round2(segments.widestSegmentMedianZ),
        ...(binCount && !observation.overload ? { peakFrequencyHz: Math.round(analyzedRangeHz[0] + (peakBin + 0.5) * binWidthHz) } : {}),
        peakLevel: levelAtPeak,
        usualLevelAtPeak: usualAtPeak,
        levelAboveUsual: levelAtPeak - usualAtPeak,
        ...(burstPeakZ !== undefined ? { burstPeakZ: round2(burstPeakZ) } : {}),
      },
      rules: ruleComparisons,
      persistence: {
        votes: tracker?.votes ?? 1,
        window: values.alertWindow,
        required: observation.overload ? 1 : values.alertVisits,
        exposureMs: tracker?.exposureMs ?? observation.exposureMs,
        requiredExposureMs: values.minExposureMs,
      },
      disturbedRangesHz,
      analyzedRangeHz,
      binWidthHz: Math.round(binWidthHz),
    };
    const levels = observation.bins;
    const usual = Uint8Array.from(referenceState.medians);
    const mads = Uint8Array.from(referenceState.mads);
    const scaleFloor = this.thresholds.scaleFloorBins;
    const triggerSnapshot = (eventId: string): AlertTriggerSnapshot => buildTriggerSnapshot({
      eventId,
      observation,
      detail,
      policyHash: policy.hash,
      analyzedRangeHz,
      levels,
      usual,
      mads,
      scaleFloor,
      alertSigma: values.segmentSigma,
      anomalyBinRanges,
    });
    return {
      disposition,
      metrics,
      baseline,
      candidate,
      alertEligible,
      trainingEligible,
      analysis,
      gauge,
      reference,
      triggerSnapshot,
      event: {
        dataDomain: observation.dataDomain,
        kind: publicDetectionKind(detail, band.service),
        detailKind: detail,
        status: detail === "noise-floor" || detail === "overload" || detail === "burst" ? "suspicious" : "interference-likely",
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
        affectedRangeHz: analyzedRangeHz,
        disturbedRangesHz,
        trigger,
        observed: describeObservation({
          detail,
          gnss: band.service === "gnss",
          lifecycle: baseline.lifecycle,
          disturbedRangesHz,
          occupancyRatio: segments.occupancy,
          votes: trigger.persistence.votes,
          window: values.alertWindow,
          floorSeconds: (tracker?.floorExposureMs ?? 0) / 1_000,
        }),
        recommendedAction: band.service === "gnss"
          ? "Check position and time on an independent receiver. Keep recording."
          : "Use the approved backup channel if available. Keep recording.",
        startedAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
        metrics,
      },
    };
  }

  /** Per-frame z vectors against the same reference, for the single-frame burst rule. */
  private frameZVectors(frames: Uint8Array[] | undefined, reference: Pick<BaselineState, "medians" | "mads">, binCount: number): Float32Array[] {
    if (!frames?.length) return [];
    const usable = frames.filter((frame) => frame.length === binCount).slice(0, 5);
    if (!usable.length) return [];
    if (this.frameZScratch.length < usable.length * binCount) this.frameZScratch = new Float32Array(usable.length * binCount);
    return usable.map((frame, frameIndex) => {
      const z = this.frameZScratch.subarray(frameIndex * binCount, (frameIndex + 1) * binCount);
      for (let index = 0; index < binCount; index += 1) {
        const scale = Math.max(1.4826 * reference.mads[index], this.thresholds.scaleFloorBins);
        z[index] = Math.max(0, (frame[index] - reference.medians[index]) / scale);
      }
      return z;
    });
  }

  private updateShadowPreview(
    state: BaselineState,
    observedAtMs: number,
    exposureMs: number,
    binCount: number,
    floorMedianZ: number,
    referenceLifecycle: BaselineDescriptor["lifecycle"],
    frameZ: Float32Array[],
    voteGapMs: number,
    activeOnset: boolean,
  ): void {
    state.shadow ??= {
      firstAtMs: observedAtMs,
      trackers: Object.fromEntries(this.presetPolicies.map((preset) => [preset.id, createAlertTrackerState(preset.hash)])) as Record<AlertPresetId, AlertTrackerState>,
      onsets: Object.fromEntries(ALERT_PRESET_IDS.map((id) => [id, [] as number[]])) as Record<AlertPresetId, number[]>,
      activeOnsets: [],
    };
    const shadow = state.shadow;
    const prune = (values: number[]) => {
      const since = observedAtMs - PREVIEW_WINDOW_MS;
      while (values.length && (values[0] < since || values.length > MAX_PREVIEW_ONSETS)) values.shift();
    };
    if (activeOnset) {
      shadow.activeOnsets.push(observedAtMs);
      prune(shadow.activeOnsets);
    }
    for (const preset of this.presetPolicies) {
      const values = preset.values;
      const floorAllowed = referenceLifecycle !== "learning"
        && referenceLifecycle !== "stale"
        && (!values.noiseFloorRequiresProtected || referenceLifecycle === "protected");
      const presetSegments = segmentFeatures(this.zScratch, binCount, values.segmentSigma, values.segmentGapRatio, floorMedianZ);
      const presetClass = classifyAlert(presetSegments, values, { floorMedianZ, floorAllowed });
      let emission: EmissionKind | undefined = presetClass.emission;
      if (!emission && values.burstSigma > 0) {
        for (const z of frameZ) {
          if (burstFromFrame(segmentFeatures(z, binCount, values.burstSigma, values.segmentGapRatio, 0), values)) {
            emission = "burst";
            break;
          }
        }
      }
      const result = updateAlertTracker(shadow.trackers[preset.id], {
        atMs: observedAtMs,
        emission,
        floor: presetClass.floor,
        exposureMs,
        values,
        voteGapMs,
        policyHash: preset.hash,
      });
      if (result.onset) {
        shadow.onsets[preset.id].push(observedAtMs);
        prune(shadow.onsets[preset.id]);
      }
    }
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
      alert: createAlertTrackerState(""),
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

  private features(observation: TargetObservation, state: Pick<BaselineState, "medians" | "mads">, writeZ = false): { medianZ: number; peakZ: number; occupied6: number; occupied8: number; maxWidthRatio: number; mean: number; peak: number; baselineMean: number } {
    if (writeZ && this.zScratch.length < observation.bins.length) this.zScratch = new Float32Array(observation.bins.length);
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
      if (writeZ) this.zScratch[index] = z;
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
    detail: AlertDetailKind | undefined,
    disposition: ObservationDisposition,
    baseline: BaselineDescriptor,
    referenceState: Pick<BaselineState, "medians" | "mads"> | undefined,
    anomalyBinRanges: DetectorAnomalyBinRange[] = [],
    referenceRevision?: string,
  ): DetectorObservationAnalysis {
    const anomalyKind = analysisKindFor(detail);
    const ranges = detail && detail !== "overload" && referenceState ? anomalyBinRanges : [];
    return {
      observationId: observation.id,
      ruleSetId: this.thresholds.ruleSetId,
      disposition,
      analyzedRangeHz: analyzedFrequencyRange(observation),
      inputBinCount: observation.bins.length,
      baselineAvailable: baseline.lifecycle !== "learning" && baseline.lifecycle !== "stale" && Boolean(referenceState),
      overload: detail === "overload" || observation.overload,
      ...(anomalyKind ? { anomalyKind } : {}),
      ...(anomalyKind && detail ? { anomalyDetailKind: detail } : {}),
      ...(referenceRevision ? { referenceRevision } : {}),
      anomalyBinRanges: ranges,
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
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMHz(hz: number): string {
  return (hz / 1e6).toFixed(3);
}

function rangeText(ranges: Array<[number, number]>): string {
  if (!ranges.length) return "";
  const first = ranges[0];
  const last = ranges.at(-1)!;
  if (ranges.length === 1) return `${formatMHz(first[0])}-${formatMHz(first[1])} MHz`;
  return `${ranges.length} parts between ${formatMHz(first[0])} and ${formatMHz(last[1])} MHz`;
}

function widthText(ranges: Array<[number, number]>): string {
  const width = ranges.reduce((total, [start, end]) => total + (end - start), 0) / 1e6;
  return width >= 1 ? `${width.toFixed(1)} MHz` : `${Math.max(1, Math.round(width * 1_000))} kHz`;
}

/** Plain operator copy naming where the disturbance was. Never claims intent or calibration. */
export function describeObservation(input: {
  detail: AlertDetailKind;
  gnss: boolean;
  lifecycle: BaselineDescriptor["lifecycle"];
  disturbedRangesHz: Array<[number, number]>;
  occupancyRatio: number;
  votes: number;
  window: number;
  floorSeconds: number;
}): string {
  const where = rangeText(input.disturbedRangesHz);
  const repeated = `in ${input.votes} of the last ${input.window} checks`;
  let sentence: string;
  switch (input.detail) {
    case "overload":
      return "Receiver input is overloaded. Readings may be wrong.";
    case "wideband":
      sentence = `Raised RF energy across ${Math.round(input.occupancyRatio * 100)}% of the checked window ${repeated}.`;
      break;
    case "partial-band":
      sentence = `Raised RF energy over ${widthText(input.disturbedRangesHz)}${where ? ` (${where})` : ""} ${repeated}.`;
      break;
    case "narrowband":
      sentence = `Raised narrowband energy${where ? ` at ${where}` : ""} stayed above its usual level ${repeated}.`;
      break;
    case "burst":
      sentence = `Short bursts of RF energy${where ? ` over ${where}` : ""} were seen in single frames ${repeated}.`;
      break;
    case "noise-floor":
      sentence = `The whole window sat above the ${input.lifecycle === "protected" ? "approved baseline" : "local reference"} for ${Math.round(input.floorSeconds)} s of observation.`;
      break;
  }
  return input.gnss ? `${sentence} RF data can show interference, not intent.` : sentence;
}

function hex(values: Uint8Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("hex");
}

function reduceMax(values: Uint8Array, outputCount: number): Uint8Array {
  if (values.length <= outputCount) return Uint8Array.from(values);
  const output = new Uint8Array(outputCount);
  for (let index = 0; index < outputCount; index += 1) {
    const start = Math.floor((index * values.length) / outputCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / outputCount));
    let maximum = 0;
    for (let source = start; source < end; source += 1) maximum = Math.max(maximum, values[source]);
    output[index] = maximum;
  }
  return output;
}

function buildTriggerSnapshot(input: {
  eventId: string;
  observation: TargetObservation;
  detail: AlertDetailKind;
  policyHash: string;
  analyzedRangeHz: [number, number];
  levels: Uint8Array;
  usual: Uint8Array;
  mads: Uint8Array;
  scaleFloor: number;
  alertSigma: number;
  anomalyBinRanges: DetectorAnomalyBinRange[];
}): AlertTriggerSnapshot {
  const sourceBinCount = input.levels.length;
  const alertLevel = new Uint8Array(sourceBinCount);
  for (let index = 0; index < sourceBinCount; index += 1) {
    const scale = Math.max(1.4826 * (input.mads[index] ?? 0), input.scaleFloor);
    alertLevel[index] = Math.min(255, Math.round((input.usual[index] ?? 0) + input.alertSigma * scale));
  }
  const binCount = Math.min(sourceBinCount, MAX_TRIGGER_SNAPSHOT_BINS);
  const scale = sourceBinCount ? binCount / sourceBinCount : 1;
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    dataDomain: input.observation.dataDomain,
    targetId: input.observation.targetId,
    observationId: input.observation.id,
    observedAt: input.observation.observedAt,
    detailKind: input.detail,
    policyHash: input.policyHash,
    analyzedRangeHz: input.analyzedRangeHz,
    sourceBinCount,
    binCount,
    reduction: binCount === sourceBinCount ? "native" : "peak-preserving",
    levelsHex: hex(reduceMax(input.levels, binCount)),
    usualHex: hex(reduceMax(input.usual, binCount)),
    alertLevelHex: hex(reduceMax(alertLevel, binCount)),
    anomalyBinRanges: input.anomalyBinRanges.map((range) => ({
      startBin: Math.floor(range.startBin * scale),
      endBin: Math.max(Math.floor(range.startBin * scale) + 1, Math.ceil(range.endBin * scale)),
    })),
  };
}
