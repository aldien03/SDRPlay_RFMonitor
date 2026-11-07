import type { OperatorSummaryV1 } from "./operatorSummary";

export type LegacyServiceGroup = "startrack" | "4dx" | "gnss";
export type ServiceGroup = LegacyServiceGroup | "fugro";
/**
 * Storage and learning trust boundary. Field data is produced only while
 * simulation is explicitly disabled; every simulated/replayed path is test.
 */
export type DataDomain = "field" | "test";
export type GnssSystem = "GPS" | "GLONASS" | "Galileo" | "BeiDou" | "SBAS";
export type GnssConstellation = GnssSystem;
export type MonitorStatus = "clear" | "suspicious" | "interference-likely";
export type ConnectionState = "connecting" | "socket-open" | "api-ready" | "live" | "stale" | "offline" | "simulated";
export type HardwareState = "present" | "absent" | "unknown";
export type TransportState = "connected" | "reconnecting" | "offline";
export type StreamState = "live" | "stalled" | "stopped";
export type RecoveryState = "idle" | "waiting-for-hardware" | "requested" | "recovering" | "cooldown" | "manual-required";

export interface RecoveryOperationHealth {
  schemaVersion: 1;
  outcome: "request-accepted" | "helper-pending" | "verified-recovery" | "suppressed" | "cooldown" | "lockout" | "unavailable";
  reasonCode: string;
  requestId?: string;
  requestedAt?: string;
  retryAfterMs?: number;
  nextAttemptAt?: string;
  lockoutUntil?: string;
  attemptsInWindow?: number;
  maxAttempts?: number;
}
export type ScanProfile = "balanced" | "gnss-priority" | "fast-gnss" | "correction-watch";
export type MonitoringMission = "continuous-watch" | "gnss-survey" | "gnss-fugro-survey" | "radio-survey" | "custom";
export type TuneState = "idle" | "commanded" | "confirming" | "settling" | "confirmed" | "timed-out";
export type ChannelLifecycle = "clear" | "detecting" | "active" | "recovering";
export type IncidentLifecycle = "active" | "recovering" | "cleared" | "ended-unknown";
export type FeedCoverageMode = "live" | "scanning" | "paused" | "stale" | "unavailable";
export type OperatorStatus = "Normal" | "Checking" | "Alert";
export type NavigationIntegrityState = "unavailable" | "stale" | "nominal" | "degraded" | "suspicious";
export type DetectionKind =
  | "wideband-noise-rise"
  | "narrowband-spike"
  | "baseline-drift"
  | "overload"
  | "gnss-energy-anomaly";
export type EvidenceStrength = "Low" | "Medium" | "High";
/** Spectrum-only RF evidence cannot reach High without an independent source. */
export type RfEvidenceStrength = Exclude<EvidenceStrength, "High">;
export type ObservationDisposition = "unknown" | "clean" | "anomalous";
export type BaselineLifecycle = "learning" | "provisional" | "reviewable" | "protected" | "stale";
export type BaselineRejectionReason =
  | "anomaly-candidate"
  | "receiver-overload"
  | "target-event"
  | "resource-pressure"
  | "host-memory-pressure"
  | "application-recovery"
  | "receiver-startup-grace"
  | "receiver-recovery"
  | "evidence-unavailable"
  | "receiver-health-incomplete"
  | "detector-quarantine"
  | "tune-timeout"
  | "insufficient-frames"
  | "receiver-unhealthy"
  | "configuration-changed"
  | "tune-mismatch"
  | "bin-grid-changed"
  | "legacy-unclassified";
export type BaselineHourDisqualificationReason = "clock-integrity-unsafe" | "source-integrity-unsafe" | "legacy-unclassified";

export interface BaselineLearningExclusions {
  rejectedVisits: number;
  rejectedByReason: Partial<Record<BaselineRejectionReason, number>>;
  disqualifiedHours: number;
  disqualifiedByReason: Partial<Record<BaselineHourDisqualificationReason, number>>;
}

/** Immutable software identity for one built RF Monitor package. */
export interface ReleaseIdentity {
  schemaVersion: 1;
  product: "rf-monitor";
  releaseVersion: string;
  buildId: string;
  serverBuildId: string;
  clientBuildId: string;
  sourceDigest: string;
  packageDigest: string;
  dependencyLockDigest: string;
  integrity: "release-metadata" | "runtime-derived";
}

/** Exact software boot and versioned data/configuration context. */
export interface RuntimeIdentity {
  schemaVersion: 1;
  serviceBootId: string;
  serviceStartedAt: string;
  nodeVersion: string;
  release: ReleaseIdentity;
  protocols: {
    health: 2;
    live: 2;
    evidenceManifest: 2;
    catalogSchema: 4;
    operationalSchema: 4;
  };
  configuration: {
    catalogVersion: string;
    configurationHash: string;
    configurationRevision: number;
    detectorRuleSetId: string;
    expectedSampleRateHz: number;
  };
}

export type SyntheticExercisePhase =
  | "waiting-for-target"
  | "running"
  | "alert"
  | "recovering"
  | "inconclusive"
  | "complete";

export interface SyntheticExerciseMarker {
  synthetic: true;
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioHash: string;
  validationProtocolVersion: string;
  generatorVersion: string;
}

/**
 * A bounded, simulation-only exercise projected into the live dashboard.
 * It is never part of operational evidence, baseline learning, or commissioning.
 */
export interface SyntheticExerciseState extends SyntheticExerciseMarker {
  targetId: string;
  targetLabel: string;
  centerHz: number;
  scenarioName: string;
  expectedOutcome: "alert" | "no-alert" | "unknown";
  phase: SyntheticExercisePhase;
  startedAt?: string;
  completedAt?: string;
  elapsedMs: number;
  durationMs: number;
  progress: number;
  cleanChecks: number;
  requiredCleanChecks: number;
  observedOutcome?: "alert" | "no-alert" | "unknown";
  verdict?: string;
  stopRequested?: boolean;
}

export interface BandPreset {
  id: string;
  label: string;
  service: ServiceGroup;
  startHz: number;
  endHz: number;
  centerHz: number;
  channelSpacingHz?: number;
  channelCount?: number;
  constellation?: GnssConstellation;
  signal?: string;
  /** Fugro correction-beam metadata; the receiver observes RF only and does not decode this service. */
  correctionBeam?: {
    orbitalLongitudeDeg: number;
    linkId: number;
    symbolRateHz: number;
    bitRateBps: number;
  };
  captureTargetId?: string;
  defaultEnabled?: boolean;
  nominalDisplayHz?: number;
  captureCenterHz?: number;
  captureSpanHz?: number;
  analysisSpanHz?: number;
  revisitObjectiveMs?: number;
  captureTier?: CaptureTargetTier;
  nominalVisitMs?: number;
  maxVisitMs?: number;
  tuneAckTimeoutMs?: number;
  settleMs?: number;
  discardFrames?: number;
  minFreshFrames?: number;
  selectedFrequenciesHz?: number[];
  priority: number;
  dwellMs: number;
  editable: boolean;
}

export interface ServiceDefinition {
  id: ServiceGroup;
  label: string;
  description: string;
}

export interface BandCatalog {
  schemaVersion: 4;
  catalogVersion: string;
  services: ServiceDefinition[];
  bands: BandPreset[];
  priorityWindows: PriorityWindow[];
  captureTargets: PhysicalCaptureTarget[];
  sources: Array<{ title: string; reference: string }>;
}

export type CaptureTargetTier = "tier1" | "tier2" | "survey";

export interface PhysicalCaptureTarget {
  id: string;
  label: string;
  service: ServiceGroup;
  relatedBandIds: string[];
  centerHz: number;
  nominalDisplayHz?: number;
  captureSpanHz: number;
  analysisSpanHz: number;
  tier: CaptureTargetTier;
  defaultEnabled: boolean;
  revisitObjectiveMs: number;
  weight: number;
  nominalVisitMs: number;
  maxVisitMs: number;
  tuneAckTimeoutMs: number;
  settleMs: number;
  discardFrames: number;
  minFreshFrames: number;
}

export interface PriorityWindow {
  id: string;
  label: string;
  service: "gnss" | "fugro";
  centerHz: number;
  spanHz: number;
  relatedBandIds: string[];
}

export interface RadioChannelSelection {
  mode: "all" | "frequencies" | "range";
  frequenciesHz: number[];
  startChannel?: number;
  endChannel?: number;
}

export interface GnssSignalSelection {
  enabled: boolean;
  spanHz: number;
}

export interface GnssConstellationSelection {
  enabled: boolean;
  signals: Record<string, GnssSignalSelection>;
}

export interface GnssSelection {
  enabled: boolean;
  enabledSystemIds: GnssSystem[];
  enabledSignalIds: string[];
  constellations: Record<GnssConstellation, GnssConstellationSelection>;
}

export interface MonitoringProfile {
  startrack: { enabled: boolean; channels: RadioChannelSelection };
  "4dx": { enabled: boolean; channels: RadioChannelSelection };
  gnss: GnssSelection;
  fugro: { enabled: boolean; selectedBeamIds: string[] };
}

export interface OperationalSettings {
  schemaVersion: 5;
  revision: number;
  updatedAt: string;
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  monitoring: MonitoringProfile;
  scan: {
    profile: ScanProfile;
    priorityWindowId: string;
    maxPriorityGapMs: number;
    dwellMs: Record<ServiceGroup, number>;
    priority: Record<ServiceGroup, number>;
    /**
     * Per-window revisit objectives for the selected task, keyed by capture target id.
     * A task may relax an objective so several windows fit one receiver; the catalog
     * value applies wherever there is no entry.
     */
    revisitObjectiveOverridesMs?: Record<string, number>;
  };
  detection: DetectionRuleSettings;
  retention: EvidenceRetentionPolicy;
  liveFocusTimeoutMs: number;
}

export interface DetectionRuleSettings {
  ruleSetId: "rf-relative-mad-v1";
  scaleFloorBins: number;
  widebandObservationSigma: number;
  widebandObservationOccupancy: number;
  interferenceSigma: number;
  interferenceOccupancy: number;
  interferenceHits: number;
  interferenceWindow: number;
  interferenceExposureMs: number;
  narrowbandPeakSigma: number;
  narrowbandMaxWidthRatio: number;
  driftSigma: number;
  driftExposureMs: number;
  clearObservations: number;
  reservoirSize: number;
  minimumLearningMs: number;
}

export interface SettingsRevision {
  settings: OperationalSettings;
  catalog: BandCatalog;
  effectiveBands: BandPreset[];
  configurationHash: string;
  estimatedRevisitMs: number;
  feasibility: SettingsFeasibility;
  baselineStates: BaselineDescriptor[];
  baselineApprovals: BaselineApprovalEligibility[];
  commissioning: CommissioningHealth;
  admin: { available: boolean; unlocked: boolean; expiresAt?: string };
  infrastructure: {
    dataDomain: DataDomain;
    receiverUrls: string[];
    sampleRateHz: number;
    storageRoot: string;
    /** Folder that also receives incident images and reports for a group of users; absent when not set up. */
    shareDirectory?: string;
    bindAddress: string;
  };
}

export interface BaselineApprovalEligibility {
  targetId: string;
  fingerprintId: string;
  learningGenerationId: string;
  eligible: boolean;
  state: "learning" | "checking" | "blocked" | "eligible" | "approved";
  label: string;
  detail?: string;
  action?: string;
  remainingMs?: number;
}

export interface ConfigurationAuditEntry {
  timestamp: string;
  revision: number;
  actor: string;
  clientAddress: string;
  changedFields: string[];
  outcome: "applied" | "rejected" | "restored";
  previousConfigurationHash: string;
  configurationHash: string;
  previousEntryHash: string;
  entryHash: string;
  reason?: string;
}

export interface FocusSession {
  id: string;
  bandId: string;
  label: string;
  service: ServiceGroup;
  receiver: number;
  centerHz: number;
  startHz: number;
  endHz: number;
  targetId?: string;
  startedAt: string;
  expiresAt: string;
}

export interface IncidentHold {
  eventId: string;
  targetId: string;
  receiver: number;
  startedAt: string;
  expiresAt: string;
}

export interface ServiceCoverageSummary {
  service: ServiceGroup;
  label: string;
  description: string;
  enabled: boolean;
  coverageLabel: string;
  targetCount: number;
  estimatedRevisitMs: number;
}

export interface ScanJob {
  id: string;
  bandId: string;
  receiver: number;
  mode: "continuous" | "sweep" | "priority-scan";
  status: "watching" | "queued" | "active" | "coverage-gap";
  nextRunAt?: string;
}

export interface ScanWindow {
  id: string;
  bandId: string;
  centerHz: number;
  startHz: number;
  endHz: number;
}

export interface SpectrumFrame {
  id: string;
  timestamp: string;
  receiver: number;
  bandId: string;
  targetId?: string;
  scanWindowId?: string;
  startHz: number;
  endHz: number;
  bins: Uint8Array;
  inputBinCount?: number;
  binning?: "native" | "peak-preserving";
  source: "sdrconnect" | "simulation";
  /** Required by persisted/live v2 producers; optional only for legacy readers. */
  dataDomain?: DataDomain;
  calibrated: boolean;
  configurationEpoch?: number;
  tuneEpoch?: number;
  visitEpoch?: number;
  visitId?: string;
  receivedMonotonicMs?: number;
  requestedCenterHz?: number;
  confirmedCenterHz?: number;
  confirmedSampleRateHz?: number;
  analysisStartBin?: number;
  analysisEndBin?: number;
  analysisSpanHz?: number;
  captureSpanHz?: number;
  tuneConfirmedAt?: string;
  /**
   * Detector-owned presentation data for this exact observation and display
   * grid. When absent, the browser must not invent a baseline or anomaly.
   * Bin ranges are half-open and refer to this frame's reduced `bins` array.
   */
  detectorAnalysis?: DetectorSpectrumAnalysis;
  /** Present only on an explicitly enabled simulation exercise frame. */
  syntheticExercise?: SyntheticExerciseMarker;
}

export interface DetectorAnomalyBinRange {
  startBin: number;
  endBin: number;
}

export interface DetectorSpectrumAnalysis {
  schemaVersion: 1;
  source: "relative-mad-detector";
  observationId: string;
  ruleSetId: string;
  disposition: ObservationDisposition;
  /** Exact analyzed RF bounds; outer capture/guard frequencies are excluded. */
  analyzedRangeHz: [number, number];
  analysisStartBin: number;
  analysisEndBin: number;
  baselineAvailable: boolean;
  /** Receiver overload is an acquisition fault, never an RF-anomaly mask. */
  overload: boolean;
  anomalyKind?: Exclude<DetectionKind, "gnss-energy-anomaly" | "overload">;
  anomalyBinRanges: DetectorAnomalyBinRange[];
}

/**
 * Evidence storage accepts only frames whose RF state and visit provenance are
 * complete. Live protocol frames retain optional fields for one-release legacy
 * compatibility, but a partial legacy frame can never enter an evidence file.
 */
export interface PersistedSpectrumFrame extends SpectrumFrame {
  dataDomain: DataDomain;
  targetId: string;
  scanWindowId: string;
  inputBinCount: number;
  binning: "native" | "peak-preserving";
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  visitId: string;
  receivedMonotonicMs: number;
  requestedCenterHz: number;
  confirmedCenterHz: number;
  confirmedSampleRateHz: number;
  analysisStartBin: number;
  analysisEndBin: number;
  analysisSpanHz: number;
  captureSpanHz: number;
  tuneConfirmedAt: string;
}

export type PersistedSpectrumFrameMetadata = Omit<PersistedSpectrumFrame, "bins">;

export interface PersistedSpectrumFrameIndexRecord {
  schemaVersion: 2;
  frame: PersistedSpectrumFrameMetadata;
  rawFile: string;
  rawOffset: number;
  rawLength: number;
  rawEncoding: "uint8";
}

export interface BaselineFingerprint {
  schemaVersion: 1;
  detectorVersion: string;
  /** Canonical SHA-256 of every configured detector rule value. */
  detectionRuleHash: string;
  dataDomain: DataDomain;
  /** Stable receiver/device identity; a hardware serial is required for field SDR input. */
  receiverIdentity: string;
  receiverKey: string;
  deviceName: string;
  deviceSerial?: string;
  sdrconnectVersion: string;
  activeAntenna: string;
  gainProfileId: string;
  targetId: string;
  centerHz: number;
  sampleRateHz: number;
  inputBinCount: number;
  analysisStartBin: number;
  analysisEndBin: number;
  analysisMaskHash: string;
  spectrumReference: number;
  spectrumBase: number;
  catalogVersion: string;
}

export interface BaselineDescriptor {
  dataDomain: DataDomain;
  targetId: string;
  lifecycle: BaselineLifecycle;
  fingerprintId: string;
  baselineId?: string;
  learningGenerationId: string;
  observationCount: number;
  validCoverageRatio: number;
  representativeHours: number;
  learningStartedAt: string;
  protectedAt?: string;
  reason?: string;
  learningExclusions?: BaselineLearningExclusions;
}

export interface TargetObservation {
  dataDomain: DataDomain;
  id: string;
  visitId: string;
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  targetId: string;
  receiver: number;
  bandId: string;
  affectedBandIds: string[];
  observedAt: string;
  firstFrameAt: string;
  lastFrameAt: string;
  exposureMs: number;
  acceptedFrameCount: number;
  bins: Uint8Array;
  confirmedCenterHz: number;
  confirmedSampleRateHz: number;
  tuneConfirmedAt: string;
  fingerprint: BaselineFingerprint;
  overload: boolean;
  healthComplete: boolean;
}

export type TargetVisitUnknownReason =
  | "tune-timeout"
  | "tune-mismatch"
  | "insufficient-frames"
  | "bin-grid-changed"
  | "receiver-unhealthy"
  | "configuration-changed";

export type TargetVisitOutcome =
  | { status: "valid"; observation: TargetObservation }
  | { status: "unknown"; targetId: string; visitId: string; observedAt: string; reason: TargetVisitUnknownReason };

export interface TargetVisit {
  id: string;
  targetId: string;
  affectedBandIds: string[];
  receiver: number;
  configurationEpoch: number;
  tuneEpoch: number;
  visitEpoch: number;
  selectedAt: string;
  commandAt?: string;
  confirmedAt?: string;
  settledAt?: string;
  completedAt?: string;
  failedAt?: string;
  discardedFrames: number;
  acceptedFrames: number;
  firstAcceptedAt?: string;
  lastAcceptedAt?: string;
  observedExposureMs?: number;
  revisitMs?: number;
  actualUnobservedGapMs?: number;
  visitDurationMs?: number;
  missedObjective?: boolean;
  missByMs?: number;
  requestedCenterHz: number;
  confirmedCenterHz?: number;
  confirmedSampleRateHz?: number;
  outcome?: TargetVisitOutcome["status"];
  failureReason?: TargetVisitUnknownReason;
}

export interface MonitorTarget {
  id: string;
  label: string;
  service: ServiceGroup;
  relatedBandIds: string[];
  centerHz: number;
  startHz: number;
  endHz: number;
  expectedRevisitMs: number;
  priority: boolean;
  coverageMode?: FeedCoverageMode;
  lastObservedAt?: string;
  nextDueAt?: string;
}

export type MonitorFeedKind = "capture-window" | "stitched-sweep";

export interface MonitorFeed {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  service: ServiceGroup;
  category: "radio" | "navigation";
  kind: MonitorFeedKind;
  enabled: boolean;
  coverageLabel: string;
  targetIds: string[];
  bandIds: string[];
  startHz: number;
  endHz: number;
  centerHz: number;
  priority: boolean;
  focusTargetId?: string;
  focusBandId?: string;
  focusCenterHz?: number;
}

export interface SweepSegment {
  targetId: string;
  startHz: number;
  endHz: number;
  observedAt: string;
  sampleCount: number;
}

export interface SweepCycle {
  id: string;
  feedId: string;
  status: "building" | "complete" | "paused" | "unavailable";
  startedAt?: string;
  lastCompletedAt?: string;
  pausedAt?: string;
  pauseReason?: "operator" | "live-focus";
  completedSegments: number;
  totalSegments: number;
  progress: number;
  elapsedMs: number;
  segments: SweepSegment[];
  stitchedFrame?: SpectrumFrame;
  waterfall: SpectrumFrame[];
}

export interface NavigationIntegritySnapshot {
  state: NavigationIntegrityState;
  receiverConnected: boolean;
  observedAt?: string;
  fixState?: string;
  satellitesUsed?: number;
  cn0Summary?: Record<string, number>;
  agc?: number;
  positionDeltaMeters?: number;
  timeDeltaMs?: number;
  alarms?: string[];
}

export type MonitorGroupKind = "constellation" | "radio";

export interface MonitorGroupMember {
  id: string;
  label: string;
  coverageLabel: string;
  bandIds: string[];
  targetIds: string[];
  centerHz: number;
  startHz: number;
  endHz: number;
  priority: boolean;
}

export interface MonitorGroup {
  id: string;
  label: string;
  description: string;
  service: ServiceGroup;
  kind: MonitorGroupKind;
  enabled: boolean;
  coverageLabel: string;
  targetIds: string[];
  members: MonitorGroupMember[];
}

export type GroupSignalState = "normal" | "checking" | "alert" | "recovering";
export type GroupCoverageState = "live" | "scanning" | "data-late" | "paused" | "offline";

export interface ChannelMonitorState {
  targetId: string;
  lifecycle: ChannelLifecycle;
  candidateCount: number;
  clearCount: number;
  requiredCount: number;
  lastObservedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  clearedAt?: string;
  eventId?: string;
  kind?: DetectionKind;
  status?: MonitorStatus;
  evidenceStrength?: RfEvidenceStrength;
  baselineLifecycle?: BaselineLifecycle;
  observationDisposition?: ObservationDisposition;
  unknownReason?: TargetVisitUnknownReason;
}

export interface PanoramaSegment {
  id: string;
  receiver: number;
  bandId: string;
  startHz: number;
  endHz: number;
  centerHz: number;
  observedAt: string;
  ageMs: number;
  stale: boolean;
  bins: Uint8Array;
}

export interface SignalMetricSample {
  timestamp: string;
  bandId: string;
  meanLevel: number;
  peakLevel: number;
  baselineLevel: number;
  baselineDelta: number;
  occupiedRatio: number;
  vendorReportedSignalPower?: number;
  snrDb?: number;
  overload: boolean;
  medianRobustZ?: number;
  peakRobustZ?: number;
  maximumOccupiedWidthRatio?: number;
}

export interface DetectionEvent {
  id: string;
  dataDomain: DataDomain;
  /** First evidence session, retained for manifest-v1 and client compatibility. */
  sessionId: string;
  /** Every rotated session containing evidence for this logical incident. */
  sessionIds?: string[];
  kind: DetectionKind;
  status: MonitorStatus;
  severity: "low" | "medium" | "high";
  evidenceStrength: RfEvidenceStrength;
  evidenceBasis: string;
  baselineId?: string;
  baselineFingerprintId: string;
  /** Exact immutable reservoir generation used when the event was created. */
  baselineGenerationId?: string;
  ruleSetId: string;
  observationId: string;
  service: ServiceGroup;
  bandId: string;
  targetId?: string;
  scanWindowId?: string;
  bandLabel: string;
  affectedBandIds?: string[];
  affectedLabel?: string;
  affectedRangeHz: [number, number];
  observed: string;
  recommendedAction: string;
  startedAt: string;
  lastSeenAt: string;
  lifecycle?: IncidentLifecycle;
  clearedAt?: string;
  endedAt?: string;
  endReason?: string;
  /** Set when history is read: a saved incident image exists. Never stored with the incident. */
  figureAvailable?: boolean;
  acknowledgedAt?: string;
  notes: Array<{ id: string; timestamp: string; text: string }>;
  metrics: SignalMetricSample;
  /** Synthetic incidents are display-only and cannot enter operational evidence. */
  syntheticExercise?: SyntheticExerciseMarker;
}

/**
 * Authoritative evidence lifecycle for manifest-v2 transactional sessions.
 *
 * `status` below is retained as a one-release compatibility alias only. It
 * cannot distinguish a successfully finalized session from an incomplete one.
 */
export type EvidenceLifecycle = "Active" | "Finalizing" | "Complete" | "Incomplete" | "Corrupt";

export type EvidenceVerificationOutcome = "not-run" | "pass" | "incomplete" | "fail";

export interface EvidenceVerificationState {
  outcome: EvidenceVerificationOutcome;
  /** Present only when a full payload verification finished. */
  verifiedAt?: string;
  /** Bounded, stable verifier reason codes; never evidence contents. */
  reasons?: string[];
}

export interface EvidenceSession {
  id: string;
  dataDomain?: DataDomain;
  startedAt: string;
  endedAt?: string;
  path: string;
  /** Authoritative for new writes. Missing only on legacy session descriptors. */
  lifecycle?: EvidenceLifecycle;
  durabilityCheckpointAt?: string;
  finalizationStartedAt?: string;
  finalizedAt?: string;
  finalizationError?: string;
  /** Independent of lifecycle: Complete means durably committed, not recently reverified. */
  verification?: EvidenceVerificationState;
  /** Legacy, non-authoritative compatibility alias. */
  status: "recording" | "closed" | "storage-error";
  frameCount: number;
  eventCount: number;
  byteCount: number;
  /** True when recovery or validation found an interval/content gap. */
  evidenceGap?: boolean;
  incompleteReasons?: string[];
}

export interface EvidenceFinalizerHealth {
  queueItems: number;
  queueLimit: number;
  oldestAgeMs: number;
  activeSessionId?: string;
  completedTotal: number;
  incompleteTotal: number;
  corruptTotal: number;
  rejectedTotal: number;
  lastFailure?: {
    sessionId: string;
    at: string;
    lifecycle: "Finalizing" | "Incomplete" | "Corrupt";
    reason: string;
  };
}

export interface EvidenceArchiveHealth {
  state: "normal" | "attention";
  activeSessionId?: string;
  finalizingSessions: number;
  incompleteSessions: number;
  corruptSessions: number;
  /** Historical archive damage never changes the current recording state. */
  issueSessionId?: string;
  action: "open-recording";
  verificationNotRunSessions: number;
  lastVerification?: EvidenceVerificationState & { sessionId: string };
  finalizer: EvidenceFinalizerHealth;
}

export interface RecordingDeletionResult {
  state: "complete" | "refused" | "recovery-required";
  dataDomain: DataDomain;
  deletedSessions: number;
  deletedBytes: number;
  retainedActiveSessions: number;
  retainedFinalizingSessions: number;
  retainedLeasedSessions: number;
  operationId: string;
  auditDurable: boolean;
  recoveryReason?: string;
}

export interface EvidenceArchiveSession extends EvidenceSession {
  events: DetectionEvent[];
  totalEvents: number;
  eventsOffset: number;
  eventsLimit: number;
  hasMoreEvents: boolean;
}

export interface EvidenceArchivePage {
  generatedAt: string;
  offset: number;
  limit: number;
  totalSessions: number;
  sessions: EvidenceArchiveSession[];
}

export interface EvidenceArchiveEventPage {
  generatedAt: string;
  sessionId: string;
  offset: number;
  limit: number;
  totalEvents: number;
  events: DetectionEvent[];
}

/** JSON-safe archived spectrum frame used only by the read-only replay API. */
export interface EvidenceReplaySpectrumFrame extends Omit<SpectrumFrame, "bins"> {
  bins: number[];
}

export interface EvidenceReplayFrame {
  frame: EvidenceReplaySpectrumFrame;
  /** Persisted receiver/detector summary. No detector is rerun during replay. */
  metrics?: SignalMetricSample;
}

export interface EvidenceReplayBatch {
  schemaVersion: 1;
  sessionId: string;
  lifecycle: "Complete" | "Incomplete";
  evidenceGap: boolean;
  incompleteReasons: string[];
  frames: EvidenceReplayFrame[];
  nextCursor?: string;
  done: boolean;
}

export interface EvidenceRetentionPolicy {
  sessionMaxBytes: number;
  sessionMaxMs: number;
  retentionMs: number;
  storageMaxBytes: number;
  minimumFreeBytes: number;
  maintenanceIntervalMs: number;
  /** Save a time-stamped picture of each incident automatically. Absent means on. */
  incidentFiguresEnabled?: boolean;
  /** How long saved incident pictures are kept before they are deleted. Absent means 30 days. */
  incidentFigureRetentionMs?: number;
}

export interface StorageMaintenanceStatus extends EvidenceRetentionPolicy {
  lastRunAt?: string;
  storageBytes?: number;
  availableBytes?: number;
  deletedSessions: number;
  deletedExports: number;
  reclaimedBytes: number;
  pressure: boolean;
}

export interface EvidenceManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  schemaVersion: 1 | 2;
  /** Added in manifest v2; absent from legacy unscoped archives. */
  dataDomain?: DataDomain;
  sessionId: string;
  generatedAt: string;
  hashAlgorithm: "SHA-256";
  files: EvidenceManifestEntry[];
  complete?: boolean;
  missingParts?: string[];
  evidenceGap?: boolean;
  /** Added in manifest v2; absent from legacy archives. */
  runtimeIdentity?: RuntimeIdentity;
  disclaimer: string;
}

export interface ReceiverState {
  id: number;
  url: string;
  connection: ConnectionState;
  activeBandId?: string;
  activeWindowId?: string;
  tunedCenterHz?: number;
  confirmedCenterHz?: number;
  confirmedSampleRateHz?: number;
  /** SDRconnect-confirmed physical input; informational only. */
  activeAntenna?: string;
  activeStartHz?: number;
  activeEndHz?: number;
  lastFrameAt?: string;
  deviceName?: string;
  deviceSerial?: string;
  apiVersion?: string;
  socketConnected?: boolean;
  apiReady?: boolean;
  deviceReady?: boolean;
  streamReady?: boolean;
  tuneState?: TuneState;
  tuneConfirmedAt?: string;
  lastError?: string;
  hardwareState?: HardwareState;
  transportState?: TransportState;
  streamState?: StreamState;
  recoveryState?: RecoveryState;
  lastFrameAgeMs?: number;
  reconnectAttempts?: number;
  nextRetryAt?: string;
}

export interface MonitorSnapshot {
  generatedAt: string;
  dataDomain: DataDomain;
  /** Present in every bootstrap so a client can reject a stale bundle. */
  identity: RuntimeIdentity;
  /** Canonical server-owned operator truth. Legacy aliases remain for one release. */
  operatorSummary: OperatorSummaryV1;
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  timestampStandard: "UTC";
  status: MonitorStatus;
  operatorStatus: OperatorStatus;
  monitoringReady: boolean;
  monitoringIssue?: string;
  paused: boolean;
  mode: "hybrid" | "priority-scan";
  coverageGaps: string[];
  services: ServiceCoverageSummary[];
  activeFocus?: FocusSession;
  syntheticExercise?: SyntheticExerciseState;
  receivers: ReceiverState[];
  scanJobs: ScanJob[];
  bands: BandPreset[];
  monitorTargets: MonitorTarget[];
  monitorGroups: MonitorGroup[];
  monitorFeeds: MonitorFeed[];
  sweepCycles: SweepCycle[];
  navigationIntegrity?: NavigationIntegritySnapshot;
  targetStates: ChannelMonitorState[];
  activeEvent?: DetectionEvent;
  events: DetectionEvent[];
  sessions: EvidenceSession[];
  currentFrame?: SpectrumFrame;
  waterfall: SpectrumFrame[];
  panorama: PanoramaSegment[];
  currentMetrics?: SignalMetricSample;
  evidenceHealthy: boolean;
  evidencePath: string;
  evidencePathStyle: "posix" | "windows";
  archiveEntryPathStyle: "posix";
  configuration: {
    explicit: boolean;
    bandCount: number;
    bandsFromFile: boolean;
    detectionFromFile: boolean;
    revision: number;
    configurationHash: string;
    catalogVersion: string;
    estimatedRevisitMs: number;
    scanProfile: ScanProfile;
    priorityWindowId: string;
    maxPriorityGapMs: number;
    measuredPriorityGapMs?: number;
  };
  storagePolicy: StorageMaintenanceStatus;
  lastUpdatedAt?: string;
}

export type MonitorStateDelta = Pick<MonitorSnapshot,
  | "generatedAt"
  | "dataDomain"
  | "identity"
  | "operatorSummary"
  | "status"
  | "operatorStatus"
  | "monitoringReady"
  | "monitoringIssue"
  | "paused"
  | "coverageGaps"
  | "activeFocus"
  | "syntheticExercise"
  | "receivers"
  | "targetStates"
  | "activeEvent"
  | "events"
  | "currentMetrics"
  | "evidenceHealthy"
  | "lastUpdatedAt"
> & Partial<Pick<MonitorSnapshot, "sweepCycles" | "panorama">> & {
  /** Critical resource pressure intentionally suppresses all spectrum payloads. */
  dashboardsStatusOnly?: boolean;
};

export type ServiceMessage =
  | {
    type: "snapshot";
    /**
     * Server-owned order within one live WebSocket connection. Internal
     * MonitorService events omit it; the HTTP/WebSocket boundary stamps it.
     */
    controlSequence?: number;
    payload: MonitorSnapshot;
  }
  | {
    type: "state-delta";
    /** See the snapshot controlSequence compatibility note above. */
    controlSequence?: number;
    payload: MonitorStateDelta;
  }
  | { type: "subscription-ack"; payload: { protocolVersion: 1 | 2; rateHz: LiveSubscription["rateHz"]; engineer: boolean; visibleTargetIds: string[]; detailTargetIds: string[]; visibleFeedIds: string[]; detailFeedIds: string[] } }
  | { type: "frame"; payload: { frame: SpectrumFrame; metrics: SignalMetricSample; event?: DetectionEvent; targetState?: ChannelMonitorState; feedId?: string } }
  | { type: "heartbeat"; payload: { generatedAt: string; monitoringReady: boolean; clients: number } }
  | { type: "error"; payload: { message: string } };

export interface LiveSubscription {
  type: "subscribe";
  /** Version 1 is accepted for one compatibility release when omitted. */
  protocolVersion?: 1 | 2;
  rateHz: 0.2 | 2 | 4;
  engineer: boolean;
  visibleTargetIds?: string[];
  detailTargetIds?: string[];
  /** Logical stitched-survey feeds. These do not expand into browser-visible physical targets. */
  visibleFeedIds?: string[];
  detailFeedIds?: string[];
  pinnedTargetIds?: string[];
}

export interface StreamingHealth {
  clients: number;
  outboundBytes: number;
  outboundBytesPerSecond: number;
  outboundBytesPerSecond10s: number;
  outboundBytesPerSecond60s: number;
  spectrumMessages: number;
  coalescedFrames: number;
  slowClientDrops: number;
  budgetDrops: number;
  duplicateSubscriptions: number;
  rejectedClients: number;
  maxBufferedBytes: number;
  startedAt: string;
  visibleClients?: number;
  hiddenClients?: number;
}

export type HostMemoryPressureState = "normal" | "pressure" | "critical" | "unknown";

export interface HostMemoryHealth {
  state: HostMemoryPressureState;
  reasonCodes: string[];
  totalBytes?: number;
  availableBytes?: number;
  availableRatio?: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
  swapFreeRatio?: number;
  psiSomeAvg10?: number;
  psiFullAvg10?: number;
  recentOomKill: boolean;
  sampledAt: string;
  normalSince?: string;
}

export interface StreamingClientHealth {
  id: string;
  connectedAt: string;
  ageMs: number;
  visibility: "visible" | "hidden";
  rateHz: LiveSubscription["rateHz"];
  engineer: boolean;
  targetCount: number;
  lastDeliveredFrameAt?: string;
  bufferedBytes: number;
  queuedBytes: number;
}

export interface StabilityIncident {
  schemaVersion: 1;
  id: string;
  kind: "host-memory-pressure" | "oom-kill" | "application-recovery" | "receiver-recovery" | "receiver-crash" | "recovery-lockout" | "evidence-gap";
  state: "active" | "resolved";
  severity: "attention" | "critical";
  startedAt: string;
  updatedAt: string;
  resolvedAt?: string;
  reasonCodes: string[];
  count: number;
}

export interface SchedulerHealth {
  profile: ScanProfile;
  configurationEpoch: number;
  tuneEpoch: number;
  activeVisit?: TargetVisit;
  completedVisits: number;
  unknownVisits: number;
  missedObjectives: number;
  tier1ValidRevisits?: number;
  tier1OnTimeRatio?: number;
  lastMissCause?: string;
  tier1MeetingObjective?: boolean;
  /** Bounded current operator truth; lifetime ratios remain qualification data. */
  currentCoverage?: {
    state: "checking" | "on-time" | "late";
    windowMs: number;
    targetId?: string;
    objectiveMs?: number;
    measuredRevisitMs?: number;
    cause?: "awaiting-revisit-measurement" | "recent-unknown-visit" | "recent-objective-miss" | "current-gap-overdue";
  };
  maximumTier1RevisitMs?: number;
  maximumTier1UnobservedGapMs?: number;
  optionalQualificationReady: boolean;
  optionalQualificationElapsedMs: number;
  optionalWorkAdmitted: boolean;
  protectedReserveRatio: number;
}

export interface CommissioningHealth {
  /** A new immutable ID is allocated whenever a clean qualification clock starts. */
  epochId: string;
  state: "simulation" | "receiver-pending" | "rf-flow-ready" | "qualifying" | "invalidated" | "qualified";
  ready: boolean;
  receiverReady: boolean;
  sampleRateReady: boolean;
  simulation: boolean;
  dataDomain: DataDomain;
  soakRequiredMs: number;
  soakElapsedMs: number;
  soakStartedAt: string;
  scanObjectiveReady: boolean;
  resourceSoakClean: boolean;
  faults: string[];
}

export interface ResourceHealth {
  state: "normal" | "pressure" | "critical";
  /** Stable machine-readable reasons from the central resource controller. */
  reasonCodes?: string[];
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  heapUtilization: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopDelayP50Ms: number;
  eventLoopDelayP99Ms: number;
  writerQueueItems: number;
  writerQueueBytes: number;
  writerOldestAgeMs: number;
  diskWriteBytesPerSecond10s: number;
  diskFreeBytes?: number;
  exportsActive: number;
  exportsQueued: number;
  baselineBytes: number;
  ringBytes: number;
  dashboardsStatusOnly: boolean;
  admitLiveClients?: boolean;
  admitExports?: boolean;
  maxDashboardRateHz?: 0.2 | 2 | 4;
  hostMemory?: HostMemoryHealth;
  pressureEnteredAt?: string;
  healthySince?: string;
}

export interface ProcessingHealth {
  spectrumFramesReceived: number;
  spectrumFramesAnalyzed: number;
  spectrumFramesDropped: number;
  /** Frames ignored while a tune was unconfirmed or settling. */
  tuneGateFramesIgnored: number;
  /** The configured fresh-frame discard count after a confirmed tune. */
  tuneFramesDiscarded: number;
  /** Obsolete input frames intentionally coalesced to the processing-rate cap. */
  rateCoalescedFrames: number;
  /** Oversized, stale-epoch, or otherwise unusable spectrum frames. */
  invalidSpectrumFramesDropped: number;
  /**
   * Frames that reached the attribution boundary with a target/visit identity
   * different from the immutable accepted epoch. This must remain zero.
   */
  acceptedAttributionInvariantViolations: number;
  unexpectedIqPayloadsDropped: number;
  evidenceFramesRecorded: number;
  evidenceFramesDropped: number;
  evidenceWritesInFlight: number;
  maxSpectrumRateHz: number;
  maxSpectrumBins: number;
  evidenceFrameIntervalMs: number;
}

export type FeasibilityReasonCode =
  | "tier1-capacity-full"
  | "tier1-capacity-overloaded"
  | "tier1-objective-unverified"
  | "tier1-objective-missed"
  | "optional-qualification-pending"
  | "optional-reserve-unavailable"
  | "experimental-sample-rate"
  | "analysis-guard-bins";

export interface FeasibilityReason {
  code: FeasibilityReasonCode;
  severity: "info" | "attention";
  targetIds?: string[];
}

export interface SettingsFeasibility {
  profile: ScanProfile;
  tier1Utilization: number;
  protectedReserveRatio: number;
  tier1Feasible: boolean;
  scheduleCapacity: "available" | "full" | "overloaded";
  optionalScans: "off" | "paused" | "admitted";
  revisitObjective: "not-verified" | "meeting" | "missed";
  optionalWorkAdmitted: boolean;
  admittedOptionalTargetIds: string[];
  pausedOptionalTargetIds: string[];
  captureSpanHz: number;
  analysisSpanHz: number;
  reasons: FeasibilityReason[];
}

export type DiagnosticSummaryState = "normal" | "attention" | "critical" | "simulation";
export type DiagnosticSeverity = "attention" | "critical";
export type DiagnosticSubsystem = "receiver" | "data" | "software" | "network" | "evidence" | "schedule";
export type DiagnosticAction =
  | "retry-receiver"
  | "open-monitoring"
  | "open-recording"
  | "open-system-health"
  | "download-diagnostics"
  | "copy-doctor-command"
  | "check-host-network"
  | "check-switch-counters";

export interface DiagnosticIssue {
  id: string;
  code: string;
  severity: DiagnosticSeverity;
  subsystem: DiagnosticSubsystem;
  active: boolean;
  value?: number;
  threshold?: number;
  unit?: string;
  count: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  action: DiagnosticAction;
}

export interface CollectorAvailability {
  state: "available" | "unavailable" | "not-tested" | "not-applicable";
  reasonCode?: string;
  lastSampleAt?: string;
}

export interface MetricWindow {
  unit: "percent" | "bytes" | "bytes-per-second" | "milliseconds" | "count" | "load";
  current: number;
  average10s: number;
  average60s: number;
  peak10s: number;
  peak60s: number;
  sampleCount: number;
}

export interface DiagnosticCounter {
  total: number;
  delta10s: number;
  delta60s: number;
  lastOccurredAt?: string;
}

export interface DataContinuityHealth {
  receivedFrames: DiagnosticCounter;
  analyzedObservations: DiagnosticCounter;
  intentionalTuneGateFrames: DiagnosticCounter;
  intentionalTuneDiscards: DiagnosticCounter;
  intentionalRateCoalescing: DiagnosticCounter;
  invalidOrStaleFrames: DiagnosticCounter;
  unexpectedIqPayloads: DiagnosticCounter;
  unknownVisits: DiagnosticCounter;
  missedObjectives: DiagnosticCounter;
  evidenceFramesRecorded: DiagnosticCounter;
  evidenceFramesLost: DiagnosticCounter;
  browserFramesCoalesced: DiagnosticCounter;
  browserFramesDropped: DiagnosticCounter;
}

export interface NetworkInterfaceHealth {
  id: string;
  state: "up" | "down" | "unknown";
  receivedBytes: DiagnosticCounter;
  transmittedBytes: DiagnosticCounter;
  receivedBytesPerSecond: MetricWindow;
  transmittedBytesPerSecond: MetricWindow;
  receiveErrors: DiagnosticCounter;
  transmitErrors: DiagnosticCounter;
  receiveDrops: DiagnosticCounter;
  transmitDrops: DiagnosticCounter;
}

export interface DistributionHealth {
  samples: number;
  last?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  maximum?: number;
}

export interface CumulativeTimingHistogram {
  /** Inclusive upper bounds for counts at the same index. */
  boundsMs: number[];
  counts: number[];
  overflow: number;
  samples: number;
}

export interface TargetTimingHealth {
  /** Counts below belong to exactly one commissioning epoch. */
  commissioningEpochId: string;
  targetId: string;
  objectiveMs: number;
  revisitMs: DistributionHealth;
  unobservedGapMs: DistributionHealth;
  /** Exact fixed-bucket commissioning-epoch distributions. */
  revisitHistogram: CumulativeTimingHistogram;
  unobservedGapHistogram: CumulativeTimingHistogram;
  /** Exact commissioning-epoch counters; distributions remain bounded samples. */
  validCompletions: number;
  validRevisits: number;
  objectiveMetRevisits: number;
  /** Valid completion-to-completion revisits that exceeded the objective. */
  objectiveMissedRevisits: number;
  /** All late attempts, including invalid visits; kept separate from valid revisit conformance. */
  objectiveBreaches: number;
  completedVisits: number;
  unknownVisits: number;
  missedObjectives: number;
  /** Cause totals for objectiveBreaches, not only valid late revisits. */
  missesByCause: Record<string, number>;
  unknownsByCause: Record<string, number>;
}

export interface CurrentMonitoringHealth {
  state: DiagnosticSummaryState;
  ready: boolean;
  monitoringReady: boolean;
  evidenceReady: boolean;
  issueCount: number;
  evaluatedAt: string;
}

export interface QualificationFaultRecord {
  code: string;
  count: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
}

export interface ProductionQualification {
  schemaVersion: 1;
  epochId: string;
  fingerprint: string;
  state: "simulation" | "pending" | "failed" | "qualified";
  ready: boolean;
  startedAt: string;
  updatedAt: string;
  releaseBuildId: string;
  configurationHash: string;
  commissioningEpochId: string;
  /** Hash-only site binding; no site or receiver identifier is exposed here. */
  siteBindingHash?: string;
  receiverModel?: "RSPdx" | "RSPdx R2";
  receiverIdentityHash?: string;
  approvalRecordId?: string;
  approvalRecordDigest?: string;
  blockers: string[];
  faults: QualificationFaultRecord[];
  faultCount?: number;
  faultsTruncated?: boolean;
  requirements: {
    immutableRelease: boolean;
    /** Browser asset, server process, and release metadata name one build. */
    clientServerBuildMatch: boolean;
    productionSampleRate: boolean;
    sampleRateConfirmed: boolean;
    physicalReceiver: boolean;
    supportedReceiverModel: boolean;
    stableReceiverIdentity: boolean;
    protectedBaselines: boolean;
    scanObjectives: boolean;
    cleanResourceSoak: boolean;
    soakComplete: boolean;
    /** Exact, separately managed release/config/site/receiver approval. */
    externalApproval: boolean;
    installedChainQualified: boolean;
    timingAndBaselineQualified: boolean;
    hardwareRecoveryQualified: boolean;
    faultQualification: boolean;
    evidenceContinuityQualified: boolean;
    /** Optional site-assurance result; it does not gate development readiness. */
    clean72HourSoakQualified: boolean;
    /** Optional site-assurance result; it does not gate development readiness. */
    controlledPilotQualified: boolean;
  };
}

export interface ProductionQualificationHistoryEntry {
  epochId: string;
  state: ProductionQualification["state"];
  ready: boolean;
  startedAt: string;
  updatedAt: string;
  releaseBuildId: string;
  configurationHash: string;
  faultCount: number;
  recentFaultCodes: string[];
}

export interface HealthSnapshotV2 {
  schemaVersion: 2;
  generatedAt: string;
  identity: RuntimeIdentity;
  /** Current operation and historical production qualification are independent. */
  currentHealth: CurrentMonitoringHealth;
  productionQualification: ProductionQualification;
  productionQualificationHistory: ProductionQualificationHistoryEntry[];
  /** Fail-closed aggregate; this is the only production-readiness boolean. */
  productionReady: boolean;
  summary: {
    state: DiagnosticSummaryState;
    issues: DiagnosticIssue[];
  };
  recovery?: {
    receiver: RecoveryOperationHealth;
    application: RecoveryOperationHealth;
  };
  receiverPath: {
    availability: CollectorAvailability;
    expectedSampleRateHz: number;
    receivers: Array<{
      id: number;
      usb: "present" | "absent" | "unknown" | "not-tested";
      transport: "connected" | "reconnecting" | "offline" | "not-tested";
      frames: "live" | "stalled" | "stopped" | "not-tested";
      tuneState?: TuneState;
      confirmedSampleRateHz?: number;
      /** SDRconnect-confirmed physical input; never a writable selector. */
      activeAntenna?: string;
      sampleRateMatches?: boolean;
      reconnectAttempts: number;
      recoveryState?: RecoveryState;
      lastFrameAgeMs?: number;
      lastHardwareError?: string;
    }>;
  };
  dataContinuity: DataContinuityHealth;
  software: {
    processCollector: CollectorAvailability;
    hostCollector: CollectorAvailability;
    rfMonitorCpuHostNormalized: MetricWindow;
    rfMonitorCpuCoreEquivalent: MetricWindow;
    hostCpu: MetricWindow;
    hostLoad1m: MetricWindow;
    rssBytes: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
    externalBytes: number;
    arrayBufferBytes: number;
    eventLoopDelayP50Ms: number;
    eventLoopDelayP99Ms: number;
    sdrconnect: {
      availability: CollectorAvailability;
      cpuCoreEquivalent?: MetricWindow;
      memoryBytes?: number;
    };
    hostMemory?: HostMemoryHealth;
    stabilityIncidents?: StabilityIncident[];
  };
  network: {
    hostCollector: CollectorAvailability;
    interfaces: NetworkInterfaceHealth[];
    managedSwitch: { availability: CollectorAvailability };
    liveBytesPerSecond10s: number;
    liveBytesPerSecond60s: number;
    applicationBytesPerSecond10s: number;
    applicationBytesPerSecond60s: number;
    dashboards: number;
    queuedBytes: number;
    drops: DiagnosticCounter;
    clients?: StreamingClientHealth[];
  };
  evidence: {
    healthy: boolean;
    writerQueueItems: number;
    writerQueueBytes: number;
    writerOldestAgeMs: number;
    writeBytesPerSecond10s: number;
    diskFreeBytes?: number;
    diskReserveBytes: number;
    diskPressure: boolean;
    exportsActive: number;
    exportsQueued: number;
    baselineBytes: number;
    ringBytes: number;
    archive: EvidenceArchiveHealth;
  };
  schedule: {
    health: SchedulerHealth;
    targets: TargetTimingHealth[];
    commissioning: CommissioningHealth;
    baselines: BaselineDescriptor[];
  };
}
