/**
 * Types shared by the synthetic RF validation generator and its offline scorer.
 *
 * Synthetic scenarios verify application behaviour only. Values are normalized
 * SDR display-bin units; they are never dB, dBm, IQ, or navigation truth.
 */

export const SYNTHETIC_SCENARIO_SCHEMA_VERSION = 1 as const;
export const SYNTHETIC_VALIDATION_PROTOCOL_VERSION = "rf-synthetic-validation-1" as const;
export const SYNTHETIC_GENERATOR_VERSION = "relative-fft-generator-1" as const;

export type SyntheticRunMode = "guided" | "blinded";

export type SyntheticEventKind =
  | "sham"
  | "wideband"
  | "pulsed-wideband"
  | "cw"
  | "multitone"
  | "moving-narrowband"
  | "overload"
  | "configuration-change"
  | "data-gap"
  | "matched-power-spoofing";

export type SyntheticExpectedOutcome = "alert" | "no-alert" | "unknown";

export interface SyntheticTargetDefinition {
  id: string;
  binCount: number;
  baselineLevel: number;
  noiseAmplitudeBins: number;
  rippleAmplitudeBins?: number;
}

interface SyntheticEventBase {
  id: string;
  targetId: string;
  kind: SyntheticEventKind;
  startMonotonicMs: number;
  endMonotonicMs: number;
  expected: {
    outcome: SyntheticExpectedOutcome;
    /** Detector event kinds allowed by the test oracle, when an alert is expected. */
    acceptedAlertKinds?: string[];
  };
}

export interface SyntheticShamEvent extends SyntheticEventBase {
  kind: "sham";
}

export interface SyntheticWidebandEvent extends SyntheticEventBase {
  kind: "wideband";
  amplitudeBins: number;
  occupancyRatio: number;
  centerRatio?: number;
}

export interface SyntheticPulsedWidebandEvent extends SyntheticEventBase {
  kind: "pulsed-wideband";
  amplitudeBins: number;
  occupancyRatio: number;
  periodMs: number;
  dutyCycle: number;
  centerRatio?: number;
}

export interface SyntheticCwEvent extends SyntheticEventBase {
  kind: "cw";
  amplitudeBins: number;
  centerBinRatio: number;
  widthBins: number;
}

export interface SyntheticMultitoneEvent extends SyntheticEventBase {
  kind: "multitone";
  amplitudeBins: number;
  toneBinRatios: number[];
  widthBins: number;
}

export interface SyntheticMovingNarrowbandEvent extends SyntheticEventBase {
  kind: "moving-narrowband";
  amplitudeBins: number;
  startBinRatio: number;
  endBinRatio: number;
  widthBins: number;
  sweepPeriodMs: number;
}

export interface SyntheticOverloadEvent extends SyntheticEventBase {
  kind: "overload";
  clipLevel?: number;
}

export interface SyntheticConfigurationChangeEvent extends SyntheticEventBase {
  kind: "configuration-change";
  configurationOffset: number;
}

export interface SyntheticDataGapEvent extends SyntheticEventBase {
  kind: "data-gap";
}

/**
 * A deliberate negative control: the post-FFT power distribution is unchanged.
 * It must never be treated as a simulated spoofing detector success.
 */
export interface SyntheticMatchedPowerSpoofingEvent extends SyntheticEventBase {
  kind: "matched-power-spoofing";
}

export type SyntheticScenarioEvent =
  | SyntheticShamEvent
  | SyntheticWidebandEvent
  | SyntheticPulsedWidebandEvent
  | SyntheticCwEvent
  | SyntheticMultitoneEvent
  | SyntheticMovingNarrowbandEvent
  | SyntheticOverloadEvent
  | SyntheticConfigurationChangeEvent
  | SyntheticDataGapEvent
  | SyntheticMatchedPowerSpoofingEvent;

export interface SyntheticScenarioDefinition {
  schemaVersion: typeof SYNTHETIC_SCENARIO_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  seed: string;
  durationMs: number;
  nominalFrameIntervalMs: number;
  targets: SyntheticTargetDefinition[];
  events: SyntheticScenarioEvent[];
}

export interface SyntheticArtifactInputs {
  /** A source revision, package digest, or other immutable build identity. */
  softwareBuild: unknown;
  configuration: unknown;
  ruleSet: unknown;
  baseline: unknown;
}

export interface SyntheticArtifactHashes {
  softwareBuildHash: string;
  configurationHash: string;
  ruleSetHash: string;
  baselineHash: string;
}

export interface SyntheticRunProvenance extends SyntheticArtifactHashes {
  validationProtocolVersion: typeof SYNTHETIC_VALIDATION_PROTOCOL_VERSION;
  generatorVersion: typeof SYNTHETIC_GENERATOR_VERSION;
  scenarioHash: string;
}

export interface SyntheticGroundTruth {
  schemaVersion: 1;
  synthetic: true;
  runId: string;
  scenario: SyntheticScenarioDefinition;
  scenarioHash: string;
}

interface SyntheticRunMetadataBase {
  schemaVersion: 1;
  synthetic: true;
  runId: string;
  mode: SyntheticRunMode;
  durationMs: number;
  targetIds: string[];
  validationProtocolVersion: typeof SYNTHETIC_VALIDATION_PROTOCOL_VERSION;
  generatorVersion: typeof SYNTHETIC_GENERATOR_VERSION;
  artifactHashes: SyntheticArtifactHashes;
  truthCommitment: string;
}

export interface SyntheticGuidedRunMetadata extends SyntheticRunMetadataBase {
  mode: "guided";
  truth: SyntheticGroundTruth;
}

export interface SyntheticBlindedRunMetadata extends SyntheticRunMetadataBase {
  mode: "blinded";
}

export type SyntheticRunMetadata = SyntheticGuidedRunMetadata | SyntheticBlindedRunMetadata;

/** Stored beside synthetic evidence so it cannot be mistaken for live evidence. */
export interface SyntheticEvidenceMarker {
  schemaVersion: 1;
  synthetic: true;
  runId: string;
  mode: SyntheticRunMode;
  validationProtocolVersion: typeof SYNTHETIC_VALIDATION_PROTOCOL_VERSION;
  generatorVersion: typeof SYNTHETIC_GENERATOR_VERSION;
  truthCommitment: string;
}

/** Operational sensor state has no scenario identity or truth labels. */
export interface SyntheticSensorState {
  dataAvailable: boolean;
  overload: boolean;
  configurationOffset: number;
}

export interface ValidationObservedAlert {
  id: string;
  targetId: string;
  kind?: string;
  startedMonotonicMs: number;
  lastSeenMonotonicMs?: number;
  clearedMonotonicMs?: number;
}

export interface ValidationObservationWindow {
  targetId: string;
  startMonotonicMs: number;
  endMonotonicMs: number;
  outcome: "valid" | "unknown";
  reason?: string;
}

export type ValidationEventVerdict =
  | "detected"
  | "missed"
  | "correct-non-detection"
  | "unexpected-alert"
  | "unknown-observed"
  | "unknown-missed";

export interface ValidationEventScore {
  eventId: string;
  targetId: string;
  kind: SyntheticEventKind;
  expectedOutcome: SyntheticExpectedOutcome;
  verdict: ValidationEventVerdict;
  matchedAlertId?: string;
  /** Total valid observation exposure inside the truth event interval. */
  observedEventExposureMs?: number;
  wallClockLatencyMs?: number;
  observedExposureToAlertMs?: number;
  /** Wall-clock latency not covered by valid observation windows. */
  unobservedLatencyToAlertMs?: number;
}

export interface ValidationLatencyDistribution {
  samples: number;
  minimumMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maximumMs?: number;
}

export interface ValidationTargetScore {
  targetId: string;
  expectedAlertEvents: number;
  detectedExpectedEvents: number;
  missedExpectedEvents: number;
  observableExpectedAlertEvents: number;
  unobservedExpectedAlertEvents: number;
  expectedNoAlertEvents: number;
  correctNonDetections: number;
  expectedUnknownEvents: number;
  observedUnknownEvents: number;
  unexpectedAlerts: number;
  falseAlertDurationMs: number;
  falseAlertsPerTargetHour: number;
  wallClockLatency: ValidationLatencyDistribution;
  observedExposureToAlert: ValidationLatencyDistribution;
  unobservedLatencyToAlert: ValidationLatencyDistribution;
}

export interface SyntheticRunScore {
  schemaVersion: 1;
  synthetic: true;
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioSeed: string;
  scenarioHash: string;
  truthCommitment: string;
  eventScores: ValidationEventScore[];
  perTarget: ValidationTargetScore[];
  expectedAlertEvents: number;
  detectedExpectedEvents: number;
  missedExpectedEvents: number;
  observableExpectedAlertEvents: number;
  detectedObservableExpectedEvents: number;
  unobservedExpectedAlertEvents: number;
  expectedNoAlertEvents: number;
  correctNonDetections: number;
  unexpectedAlerts: number;
  expectedUnknownEvents: number;
  observedUnknownEvents: number;
  detectionProbability: number | null;
  conditionalDetectionProbability: number | null;
  precision: number | null;
  falseAlertsPerTargetHour: number;
  falseAlertDurationMs: number;
  passed: boolean;
}

export interface BinomialConfidenceInterval {
  successes: number;
  trials: number;
  confidence: number;
  lower: number;
  upper: number;
  method: "wilson-score";
  side?: "two-sided" | "one-sided";
}

export interface ValidationFamilyConfidence {
  targetId: string;
  scenarioFamily: SyntheticEventKind;
  independentRuns: number;
  detectionSuccesses: number;
  detectionTrials: number;
  detectionLower95: BinomialConfidenceInterval | null;
  falseAlertFreeRuns: number;
  falseAlertTrials: number;
  falseAlertFreeLower95: BinomialConfidenceInterval | null;
}

export interface IndependentRunSummary {
  schemaVersion: 1;
  synthetic: true;
  runCount: number;
  detectionRunSuccesses: number;
  detectionRunTrials: number;
  detectionRunInterval: BinomialConfidenceInterval | null;
  falseAlertFreeRuns: number;
  falseAlertRunTrials: number;
  falseAlertFreeRunInterval: BinomialConfidenceInterval | null;
  /** One-sided 95% limits, grouped by physical target and scenario family. */
  perTargetAndFamily: ValidationFamilyConfidence[];
  allPassed: boolean;
}
