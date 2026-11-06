import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import { aggregateVisitFrames, centralAnalysisBinBounds, createBaselineFingerprint, detectionRuleFingerprint, DetectionEngine, projectDetectorAnalysisToFrame, type DetectionBaselineReference, type DetectionResult } from "../shared/detection";
import { compileScanTargets, createScanJobs, describeMonitorTarget, estimateRevisitMs, monitorTargetId, type CompiledScanTarget } from "../shared/bands";
import { captureTargetTierForProfile, createServiceSummaries, validFocusFrequencies } from "../shared/settings";
import { getMonitoringReadiness } from "../shared/monitoring";
import { createMonitorFeeds, createMonitorGroups } from "../shared/monitorGroups";
import { assertRfOnlyDetectionClaim, normalizeReceiverSerial } from "../shared/productContract";
import {
  resolveOperatorSummary,
  type OperatorMonitoringState,
  type OperatorSummaryInput,
  type OperatorSummaryV1,
} from "../shared/operatorSummary";
import type {
  BandPreset,
  BaselineApprovalEligibility,
  BaselineDescriptor,
  ChannelMonitorState,
  CommissioningHealth,
  ConnectionState,
  ConfigurationAuditEntry,
  DetectionEvent,
  EvidenceArchiveEventPage,
  EvidenceArchiveHealth,
  EvidenceArchivePage,
  EvidenceSession,
  RecordingDeletionResult,
  FocusSession,
  MonitorFeed,
  MonitorSnapshot,
  MonitorTarget,
  OperatorStatus,
  PersistedSpectrumFrame,
  ProcessingHealth,
  ReceiverState,
  ResourceHealth,
  SchedulerHealth,
  ServiceMessage,
  SignalMetricSample,
  ScanWindow,
  StorageMaintenanceStatus,
  SpectrumFrame,
  SyntheticExerciseMarker,
  SyntheticExerciseState,
  TargetTimingHealth,
  TargetVisit,
  SweepCycle,
  SweepSegment,
} from "../shared/types";
import { EvidenceStore, WRITER_ORDINARY_MAX_BYTES, WRITER_ORDINARY_MAX_ITEMS, type EvidenceInterruptionContext } from "./evidenceStore";
import {
  type ScreenshotAdmissionLease,
  validateScreenshotPng,
} from "./screenshotAdmission";
import {
  parseSdrconnectDeviceModel,
  parseSdrconnectDeviceSerial,
  SdrconnectClient,
  validateSdrconnectFrameEpoch,
  type ExpectedSdrconnectFrameEpoch,
  type SdrconnectPropertyMessage,
  type SdrconnectSpectrumPayload,
} from "./sdrconnectClient";
import { DeadlineScheduler, type VisitRecord } from "./deadlineScheduler";
import {
  BaselineRestartCommitUncertainError,
  BaselineStore,
  type BaselineDescriptor as StoredBaselineDescriptor,
  type BaselineFingerprint as StoredBaselineFingerprint,
  type BaselineRejectionReason as StoredBaselineRejectionReason,
} from "./baselineStore";
import { detectSdrplayUsb } from "./usbPresence";
import { boundedPage } from "./boundedPagination";
import { SdrMetadataGate } from "./sdrMetadataGate";
import type { RecoverySupervisorStatus } from "./recoveryRequest";
import { DEVELOPMENT_QUALIFICATION_WINDOW_MS } from "./productionQualification";
import {
  LiveSyntheticExercise,
  LIVE_SYNTHETIC_TARGET_ID,
  type LiveSyntheticSample,
} from "./liveSyntheticExercise";
import {
  clearTestDomain,
  acquireDataDomainLease,
  appendDomainMaintenanceAudit,
  ensureDomainRoot,
  inspectLegacyBaseline,
  readBaselineRestartOperation,
  removeBaselineRestartOperation,
  repairInterruptedTestClear,
  writeBaselineRestartOperation,
  type BaselineRestartOperation,
  type ClearedTestData,
  type DataDomainLease,
  type LegacyBaselineQuarantine,
} from "./dataDomains";

export type MonitorAtomicityFaultPoint =
  | "baseline-before-prepared-audit"
  | "baseline-after-file-rename"
  | "baseline-after-persistent-commit"
  | "baseline-before-detector-reset"
  | "baseline-before-completion-audit"
  | "baseline-before-journal-cleanup"
  | "clear-before-runtime-reopen"
  | "clear-after-runtime-reopen";

export interface MonitorServiceOptions {
  /** Deterministic transaction-boundary seam used only by tests. */
  injectAtomicityFault?: (point: MonitorAtomicityFaultPoint) => void | Promise<void>;
  interruptionContextPath?: string;
  receiverStartupGraceMs?: number;
}

export interface BaselineRestartResult {
  baseline: BaselineDescriptor;
  operationId: string;
  committed: true;
  state: "complete" | "recovery-required";
  auditDurable: boolean;
  recoveryReason?: string;
}

export interface TestDataClearResult extends ClearedTestData {
  runtimeState: "active" | "recovery-required";
}

const COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS = Object.freeze([
  250, 500, 750, 1_000, 1_250, 1_500, 2_000, 3_000, 4_000,
  5_000, 6_000, 8_000, 10_000, 15_000, 30_000, 60_000,
]);

interface CommissioningTimingHistograms {
  revisitCounts: number[];
  revisitOverflow: number;
  revisitSamples: number;
  gapCounts: number[];
  gapOverflow: number;
  gapSamples: number;
}

export class CommittedBaselineRestartRecoveryError extends Error {
  readonly committed = true;

  constructor(readonly operation: BaselineRestartOperation, message: string) {
    super(message);
    this.name = "CommittedBaselineRestartRecoveryError";
  }
}

export class BaselineApprovalUnavailableError extends Error {
  readonly code = "BASELINE_APPROVAL_BLOCKED";

  constructor(readonly approval: BaselineApprovalEligibility) {
    super(approval.detail ?? approval.label);
    this.name = "BaselineApprovalUnavailableError";
  }
}

interface ReceiverMetricState {
  vendorReportedSignalPower?: number;
  snrDb?: number;
  overload: boolean;
  activeAntenna?: string;
  spectrumReference?: number;
  spectrumBase?: number;
  gainProfileId?: string;
  gainReduction?: string;
  lnaState?: string;
  ifGain?: string;
}

interface BandAssignment {
  receiver: number;
  targets: CompiledScanTarget[];
  scheduler: DeadlineScheduler;
  timer?: NodeJS.Timeout;
  active?: VisitAccumulator;
}

interface VisitAccumulator {
  visit: TargetVisit;
  epoch: Readonly<ExpectedSdrconnectFrameEpoch>;
  target: CompiledScanTarget;
  frames: SpectrumFrame[];
  extended: boolean;
  startedMonotonicMs: number;
}

interface SyntheticFrameContext extends LiveSyntheticSample {}

interface SyntheticRestoreState {
  targetId: string;
  targetState?: ChannelMonitorState;
  frame?: SpectrumFrame;
  metrics?: SignalMetricSample;
  waterfall: SpectrumFrame[];
}

interface SweepBuilderSegment extends SweepSegment {
  bins: Uint8Array;
  analysisStartBin: number;
  analysisEndBin: number;
  receiver: number;
  source: SpectrumFrame["source"];
  calibrated: boolean;
}

interface SweepBuilderState {
  id: string;
  feedId: string;
  startedAt: string;
  segments: Map<string, SweepBuilderSegment>;
}

interface CompletedSweepState {
  frame: SpectrumFrame;
  metrics: SignalMetricSample;
  waterfall: SpectrumFrame[];
  completedAt: string;
  segments: SweepSegment[];
}

const STITCHED_SWEEP_BIN_COUNT = 720;
const MAX_EVENT_NOTES = 32;
const MAX_EVENT_NOTE_BYTES = 32 * 1024;

export function reduceSpectrumBins(input: ArrayLike<number>, maxBins: number): Uint8Array {
  const outputSize = Math.max(1, Math.min(input.length, Math.floor(maxBins)));
  if (!input.length) return new Uint8Array();
  if (input.length <= outputSize) return Uint8Array.from(input);
  const output = new Uint8Array(outputSize);
  for (let outputIndex = 0; outputIndex < outputSize; outputIndex += 1) {
    const start = Math.floor((outputIndex * input.length) / outputSize);
    const end = Math.max(start + 1, Math.floor(((outputIndex + 1) * input.length) / outputSize));
    let peak = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      if (input[inputIndex] > peak) peak = input[inputIndex];
    }
    output[outputIndex] = peak;
  }
  return output;
}

function stitchSweepBins(segments: SweepBuilderSegment[], startHz: number, endHz: number): {
  bins: Uint8Array;
  analysisStartBin: number;
  analysisEndBin: number;
} {
  const bins = new Uint8Array(STITCHED_SWEEP_BIN_COUNT);
  const covered = new Uint8Array(STITCHED_SWEEP_BIN_COUNT);
  const spanHz = Math.max(1, endHz - startHz);
  for (const segment of segments) {
    const segmentSpan = Math.max(1, segment.endHz - segment.startHz);
    const analysisStart = Math.max(0, Math.min(segment.bins.length, segment.analysisStartBin));
    const analysisEnd = Math.max(analysisStart, Math.min(segment.bins.length, segment.analysisEndBin));
    for (let index = analysisStart; index < analysisEnd; index += 1) {
      const value = segment.bins[index];
      const frequency = segment.startHz + (index / Math.max(1, segment.bins.length - 1)) * segmentSpan;
      const outputIndex = Math.max(0, Math.min(STITCHED_SWEEP_BIN_COUNT - 1, Math.round(((frequency - startHz) / spanHz) * (STITCHED_SWEEP_BIN_COUNT - 1))));
      bins[outputIndex] = Math.max(bins[outputIndex], value);
      covered[outputIndex] = 1;
    }
  }
  const analysisStartBin = covered.findIndex((value) => value === 1);
  let analysisEndBin = covered.length;
  while (analysisEndBin > 0 && covered[analysisEndBin - 1] === 0) analysisEndBin -= 1;
  return {
    bins,
    analysisStartBin: analysisStartBin < 0 ? 0 : analysisStartBin,
    analysisEndBin: analysisStartBin < 0 ? 0 : analysisEndBin,
  };
}

export class MonitorService extends EventEmitter {
  private static readonly COMMISSIONING_SOAK_MS = DEVELOPMENT_QUALIFICATION_WINDOW_MS;
  private static readonly COMMISSIONING_WARMUP_MS = 5 * 60_000;
  private detector: DetectionEngine;
  private evidence: EvidenceStore;
  private readonly clients: SdrconnectClient[] = [];
  private readonly receiverStates: ReceiverState[];
  private readonly receiverMetrics = new Map<number, ReceiverMetricState>();
  private readonly sdrMetadataGate = new SdrMetadataGate();
  private readonly assignments: BandAssignment[] = [];
  private readonly frameCounters = new Map<string, number>();
  private simulator?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private receiverHealthTimer?: NodeJS.Timeout;
  private lastSnapshotBroadcastAt = 0;
  private maintenanceRunning = false;
  private readonly maintenanceIdleWaiters: Array<() => void> = [];
  private reconfiguring = false;
  private paused = false;
  private evidenceHealthy = true;
  private events: DetectionEvent[] = [];
  private waterfall: SpectrumFrame[] = [];
  private readonly waterfallByTarget = new Map<string, SpectrumFrame[]>();
  private readonly frameByTarget = new Map<string, SpectrumFrame>();
  private readonly metricsByTarget = new Map<string, SignalMetricSample>();
  private readonly targetStates = new Map<string, ChannelMonitorState>();
  private readonly activeEventsByTarget = new Map<string, DetectionEvent>();
  private currentFrame?: SpectrumFrame;
  private currentMetrics?: SignalMetricSample;
  private activeEvent?: DetectionEvent;
  private activeFocus?: FocusSession;
  private activeFocusEpoch?: Readonly<ExpectedSdrconnectFrameEpoch>;
  private readonly sweepBuilders = new Map<string, SweepBuilderState>();
  private readonly completedSweeps = new Map<string, CompletedSweepState>();
  private lastUpdatedAt?: string;
  private measuredPriorityGapMs?: number;
  private commissioningEpochId = randomUUID();
  private commissioningStartedAtMonotonicMs = performance.now() + MonitorService.COMMISSIONING_WARMUP_MS;
  private commissioningStartedAtWallMs = Date.now() + MonitorService.COMMISSIONING_WARMUP_MS;
  private readonly commissioningFaults = new Set<string>();
  /**
   * Qualification cadence starts at the end of warm-up. The main scheduler
   * intentionally runs during preparation, so its lifetime counters cannot be
   * used as the qualification epoch without allowing startup visits to bias a
   * later 24-hour result.
   */
  private readonly commissioningLastValidCompletionByTarget = new Map<string, number>();
  private readonly commissioningValidRevisitsByTarget = new Map<string, number>();
  private readonly commissioningOnTimeRevisitsByTarget = new Map<string, number>();
  private resourcePressureActive = false;
  private resourceDashboardsStatusOnly = false;
  private resourceHealthState: ResourceHealth["state"] = "normal";
  private hostMemoryPressureActive = false;
  private receiverRecoveryActive = false;
  private applicationRecoveryActive = false;
  private readonly receiverStartupGraceUntil: number;
  private operatorMonitoringState?: OperatorMonitoringState;
  private operatorMonitoringStateSince: string;
  private spectrumFramesAnalyzed = 0;
  private evidenceFramesRecorded = 0;
  private evidenceFramesDropped = 0;
  /** Lifetime evidence counters stay monotonic; qualification compares its own epoch. */
  private commissioningEvidenceFramesDroppedAtStart = 0;
  private evidenceWritesInFlight = 0;
  private evidenceWriteBytesInFlight = 0;
  private readonly evidenceWriteStartedAt: number[] = [];
  private readonly evidenceWriteSamples: Array<{ at: number; bytes: number }> = [];
  private readonly timingHistoryByTarget = new Map<string, VisitRecord[]>();
  private readonly timingCauseTotalsByTarget = new Map<string, {
    misses: Record<string, number>;
    unknowns: Record<string, number>;
  }>();
  private readonly timingHistogramsByTarget = new Map<string, CommissioningTimingHistograms>();
  private readonly lastEvidenceFrameAtByTarget = new Map<string, number>();
  private readonly lastBaselineTrainingAtByTarget = new Map<string, number>();
  private readonly spectrumRingByReceiver = new Map<number, PersistedSpectrumFrame[]>();
  private readonly prehistoryCandidateTargets = new Set<string>();
  private readonly prehistoryFrozenReceivers = new Set<number>();
  private readonly postClearUntilByTarget = new Map<string, number>();
  private sessionList: EvidenceSession[] = [];
  private storageMaintenance: StorageMaintenanceStatus;
  private baselineStore?: BaselineStore;
  private readonly activeBaselineFingerprints = new Map<string, StoredBaselineFingerprint>();
  private readonly activeBaselineFingerprintIdByTarget = new Map<string, string>();
  private baselineHealthy = true;
  private configurationEpoch = 1;
  private visitEpoch = 0;
  private rejectedRfEpochFrames = 0;
  private acceptedAttributionInvariantViolations = 0;
  private syntheticTuneEpoch = 0;
  private sessionContextTimer?: NodeJS.Timeout;
  private syntheticExercise?: LiveSyntheticExercise;
  private syntheticRestore?: SyntheticRestoreState;
  private legacyBaselineQuarantine?: LegacyBaselineQuarantine;
  private readonly baselineRestartTargets = new Set<string>();
  private domainLease?: DataDomainLease;

  constructor(private config: AppConfig, private readonly serviceOptions: MonitorServiceOptions = {}) {
    super();
    const receiverStartupGraceMs = serviceOptions.receiverStartupGraceMs ?? (config.dataDomain === "field" ? 90_000 : 0);
    this.receiverStartupGraceUntil = performance.now() + Math.max(0, receiverStartupGraceMs);
    this.operatorMonitoringStateSince = config.runtimeIdentity.serviceStartedAt;
    this.detector = new DetectionEngine(config.detectionThresholds);
    this.evidence = new EvidenceStore(config.storageRoot, { dataDomain: config.dataDomain });
    this.storageMaintenance = {
      ...config.retentionPolicy,
      deletedSessions: 0,
      deletedExports: 0,
      reclaimedBytes: 0,
      pressure: false,
    };
    this.receiverStates = config.receiverUrls.map((url, id) => ({
      id,
      url,
      connection: "offline",
      socketConnected: false,
      apiReady: false,
      deviceReady: false,
      streamReady: false,
      tuneState: "idle",
      hardwareState: "unknown",
      transportState: "offline",
      streamState: "stopped",
      recoveryState: "idle",
      reconnectAttempts: 0,
    }));
  }

  async start(): Promise<void> {
    // Clear test data is a global protected action even while field monitoring
    // is active, so every startup repairs its one bounded control journal.
    await repairInterruptedTestClear(this.config.dataRoots);
    await ensureDomainRoot(this.config.dataRoots[this.config.dataDomain].root, this.config.dataDomain);
    this.domainLease = await acquireDataDomainLease(this.config.dataRoots[this.config.dataDomain].root, this.config.dataDomain);
    this.legacyBaselineQuarantine = await inspectLegacyBaseline(this.config.dataRoots.legacyBaselineFile);
    try {
      this.baselineStore = await BaselineStore.open({
        filePath: this.config.dataRoots[this.config.dataDomain].baselineFile,
        dataDomain: this.config.dataDomain,
        reservoirCapacity: this.config.detectionThresholds.reservoirSize,
        provisionalMinimumMs: this.config.detectionThresholds.minimumLearningMs,
        maxTargets: 32,
        injectAtomicWriteFault: () => this.serviceOptions.injectAtomicityFault?.("baseline-after-file-rename"),
      });
      const restartRecovery = await this.repairBaselineRestartOperation();
      if (restartRecovery?.state === "recovery-required") {
        this.baselineHealthy = false;
        this.emitServiceError(`Signal learning restart ${restartRecovery.operationId} requires recovery: ${restartRecovery.recoveryReason ?? "unknown failure"}`);
      }
    } catch (error) {
      this.baselineHealthy = false;
      this.emitServiceError(error instanceof Error ? error.message : String(error));
    }
    try {
      const interruption = await this.consumeInterruptionContext();
      await this.evidence.initialize(this.sessionMetadata(), interruption);
      if (interruption?.cause) this.commissioningFaults.add(`application-restart:${interruption.cause}`);
      await this.refreshSessionList();
    } catch (error) {
      this.evidenceHealthy = false;
      this.emitServiceError(`Evidence storage unavailable: ${String(error)}`);
    }

    if (this.config.simulation !== "on") {
      await this.connectReceivers();
    }
    const connected = this.receiverStates.some((receiver) => receiver.connection === "live");
    if (this.config.simulation === "on" || (this.config.simulation === "auto" && !connected)) {
      this.startSimulation();
    }
    this.configureAssignments();
    this.receiverHealthTimer = setInterval(() => void this.refreshReceiverHealth(), 2_000);
    this.receiverHealthTimer.unref();
    await this.refreshReceiverHealth();
    this.maintenanceTimer = setInterval(() => void this.runStorageMaintenance(), this.config.retentionPolicy.maintenanceIntervalMs);
    this.maintenanceTimer.unref();
    this.scheduleAllAssignments();
    await this.runStorageMaintenance();
    this.broadcastSnapshot();
  }

  async stop(): Promise<void> {
    this.clearSyntheticExercise(false);
    for (const assignment of this.assignments) if (assignment.timer) clearTimeout(assignment.timer);
    if (this.simulator) clearInterval(this.simulator);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.storageReprobeTimer) clearTimeout(this.storageReprobeTimer);
    if (this.receiverHealthTimer) clearInterval(this.receiverHealthTimer);
    if (this.sessionContextTimer) clearTimeout(this.sessionContextTimer);
    if (this.evidence.currentSession) await this.checkpointSessionContext("service-stopping").catch(() => undefined);
    for (const client of this.clients) client.close();
    await this.baselineStore?.close().catch(() => undefined);
    if (this.evidence.currentSession) {
      await this.evidence.closeActive().catch((error) => {
        console.error(`Evidence session could not be closed cleanly; it will be reconciled as interrupted on next start: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await this.domainLease?.release().catch(() => undefined);
    this.domainLease = undefined;
  }

  getSnapshot(): MonitorSnapshot {
    this.expireFocus();
    this.expireIncident();
    const now = Date.now();
    const generatedAt = new Date(now).toISOString();
    const receiverCount = this.receiverStates.length || 1;
    const currentSession = this.evidence.currentSession;
    const sessions = [
      ...(currentSession ? [currentSession] : []),
      ...this.sessionList.filter((session) => session.id !== currentSession?.id),
    ];
    const targetCount = compileScanTargets(this.config.bands, this.config.sampleRateHz).length;
    const coverageGaps: string[] = [];
    if (targetCount > receiverCount) coverageGaps.push("The receiver scans selected frequencies in turn. Each frequency is briefly unseen between scans.");
    if (this.activeFocus) coverageGaps.unshift(`Checking ${this.activeFocus.label}. Other frequencies on receiver ${this.activeFocus.receiver + 1} are paused.`);
    const syntheticExercise = this.syntheticExercise?.getState();
    const focusKey = syntheticExercise?.targetId ?? this.activeEvent?.targetId ?? this.currentFrame?.targetId;
    const focusedFrame = focusKey ? this.frameByTarget.get(focusKey) : this.currentFrame;
    const focusedMetrics = focusKey ? this.metricsByTarget.get(focusKey) : this.currentMetrics;
    const focusedWaterfall = focusKey ? (this.waterfallByTarget.get(focusKey) ?? []) : this.waterfall;
    const monitoring = getMonitoringReadiness(this.receiverStates);
    const monitorTargets = this.decorateMonitorTargets(this.getMonitorTargets(), monitoring.ready, now);
    const services = createServiceSummaries(this.config.bandCatalog, this.config.operationalSettings, this.config.bands, this.config.sampleRateHz);
    const monitorGroups = createMonitorGroups(this.config.bandCatalog, this.config.bands, monitorTargets, services);
    const monitorFeeds = createMonitorFeeds(this.config.bandCatalog, this.config.bands, monitorTargets, services);
    const targetStates = monitorTargets.map((target) => this.targetStates.get(target.id) ?? this.clearTargetState(target.id));
    const operatorSummary = this.buildOperatorSummary({
      generatedAt,
      monitoringReady: monitoring.ready,
      monitorTargets,
      targetStates,
      currentSession,
    });
    return {
      generatedAt,
      dataDomain: this.config.dataDomain,
      identity: this.config.runtimeIdentity,
      operatorSummary,
      siteName: this.config.siteName,
      deploymentId: this.config.deploymentId,
      displayTimeZone: this.config.displayTimeZone,
      timestampStandard: "UTC",
      status: this.activeEvent?.status ?? "clear",
      operatorStatus: this.operatorStatus(monitoring.ready, monitorTargets),
      monitoringReady: monitoring.ready,
      monitoringIssue: monitoring.issue,
      paused: this.paused,
      mode: receiverCount >= 2 ? "hybrid" : "priority-scan",
      coverageGaps,
      services,
      activeFocus: this.activeFocus ? { ...this.activeFocus } : undefined,
      syntheticExercise,
      receivers: this.receiverStates.map((receiver) => ({
        ...receiver,
        lastFrameAgeMs: receiver.lastFrameAt ? Math.max(0, Date.now() - Date.parse(receiver.lastFrameAt)) : undefined,
      })),
      scanJobs: createScanJobs(this.config.bands, receiverCount),
      bands: this.config.bands,
      monitorTargets,
      monitorGroups,
      monitorFeeds,
      sweepCycles: this.getSweepCycles(monitorFeeds, monitoring.ready, now),
      targetStates,
      activeEvent: this.activeEvent,
      events: this.events,
      sessions,
      currentFrame: focusedFrame,
      waterfall: focusedWaterfall,
      panorama: [...this.frameByTarget.values()].map((frame) => {
        const observedMs = Date.parse(frame.timestamp);
        const ageMs = Math.max(0, Date.now() - observedMs);
        return { id: frame.scanWindowId ?? frame.id, receiver: frame.receiver, bandId: frame.bandId, startHz: frame.startHz, endHz: frame.endHz, centerHz: Math.round((frame.startHz + frame.endHz) / 2), observedAt: frame.timestamp, ageMs, stale: ageMs > Math.max(15_000, this.config.operationalSettings.scan.maxPriorityGapMs * 2), bins: frame.bins };
      }).sort((left, right) => left.startHz - right.startHz),
      currentMetrics: focusedMetrics,
      evidenceHealthy: this.evidenceHealthy,
      evidencePath: this.config.storageRoot,
      evidencePathStyle: path.sep === "\\" ? "windows" : "posix",
      archiveEntryPathStyle: "posix",
      configuration: {
        explicit: this.config.configurationSources.explicit,
        bandCount: this.config.bands.length,
        bandsFromFile: this.config.configurationSources.bands !== "built-in defaults",
        detectionFromFile: !this.config.configurationSources.detection.startsWith("built-in"),
        revision: this.config.operationalSettings.revision,
        configurationHash: this.config.configurationHash,
        catalogVersion: this.config.bandCatalog.catalogVersion,
        estimatedRevisitMs: estimateRevisitMs(this.config.bands, this.config.sampleRateHz),
        scanProfile: this.config.operationalSettings.scan.profile,
        priorityWindowId: this.config.operationalSettings.scan.priorityWindowId,
        maxPriorityGapMs: this.config.operationalSettings.scan.maxPriorityGapMs,
        measuredPriorityGapMs: this.measuredPriorityGapMs,
      },
      storagePolicy: this.storageMaintenance,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  getSyntheticExercise(): SyntheticExerciseState | undefined {
    return this.syntheticExercise?.getState();
  }

  getDataDomainStatus(): {
    active: "field" | "test";
    legacyBaseline: Omit<LegacyBaselineQuarantine, "sourcePath">;
  } {
    const legacy = this.legacyBaselineQuarantine;
    return {
      active: this.config.dataDomain,
      legacyBaseline: legacy
        ? {
            state: legacy.state,
            reason: legacy.reason,
            sha256: legacy.sha256,
            bytes: legacy.bytes,
            recordCount: legacy.recordCount,
          }
        : { state: "none" },
    };
  }

  startSyntheticExercise(scenarioId: string, targetId = LIVE_SYNTHETIC_TARGET_ID): SyntheticExerciseState {
    if (this.config.simulation !== "on" || !this.config.syntheticExercises) {
      throw new Error("Live synthetic exercises are not enabled");
    }
    if (this.syntheticExercise) throw new Error("A synthetic exercise is already active");
    if (this.paused) throw new Error("Resume monitoring before starting a test");
    if (this.reconfiguring) throw new Error("Wait for the settings change to finish");
    if (this.activeFocus) throw new Error("Resume the normal survey before starting a test");
    if (this.activeEvent) throw new Error("Wait for the current incident to clear before starting a test");
    const target = this.config.bandCatalog.captureTargets.find((candidate) => candidate.id === targetId);
    if (!target || target.tier !== "tier1" || target.service !== "gnss") {
      throw new Error("Select an enabled Tier-1 GNSS target");
    }
    const targetEnabled = this.assignments.some((assignment) => assignment.targets.some((candidate) => candidate.id === targetId));
    if (!targetEnabled) throw new Error(`${target.label} is not enabled`);
    const currentVisitId = this.assignments
      .map((assignment) => assignment.active)
      .find((active) => active?.target.id === targetId)?.visit.id;
    this.syntheticRestore = {
      targetId,
      targetState: this.targetStates.get(targetId),
      frame: this.frameByTarget.get(targetId),
      metrics: this.metricsByTarget.get(targetId),
      waterfall: [...(this.waterfallByTarget.get(targetId) ?? [])],
    };
    this.syntheticExercise = new LiveSyntheticExercise({
      scenarioId,
      thresholds: this.config.detectionThresholds,
      target,
      affectedBands: this.config.bands.filter((band) => band.captureTargetId === targetId),
      excludedVisitId: currentVisitId,
      configurationHash: this.config.configurationHash,
      catalogVersion: this.config.bandCatalog.catalogVersion,
      sampleRateHz: this.config.sampleRateHz,
    });
    this.broadcastSnapshot();
    return this.syntheticExercise.getState();
  }

  stopSyntheticExercise(): SyntheticExerciseState | undefined {
    const exercise = this.syntheticExercise;
    if (!exercise) return undefined;
    if (!exercise.isComplete && exercise.hasActiveAlert) {
      exercise.requestStop();
      this.broadcastSnapshot();
      return exercise.getState();
    }
    this.clearSyntheticExercise();
    return undefined;
  }

  getTargetFrames(targetIds: string[]): Array<Extract<ServiceMessage, { type: "frame" }>> {
    const requested = new Set(targetIds);
    if (!requested.size) return [];
    return [...this.frameByTarget.entries()]
      .filter(([targetId]) => requested.has(targetId))
      .flatMap(([targetId, frame]) => {
        const metrics = this.metricsByTarget.get(targetId);
        const targetState = this.targetStates.get(targetId);
        if (!metrics || !targetState) return [];
        const event = targetState.eventId ? this.events.find((candidate) => candidate.id === targetState.eventId) : undefined;
        return [{ type: "frame" as const, payload: { frame, metrics, event, targetState } }];
      });
  }

  getSweepFrames(feedIds: string[]): Array<Extract<ServiceMessage, { type: "frame" }>> {
    const requested = new Set(feedIds);
    if (!requested.size) return [];
    return [...this.completedSweeps.entries()]
      .filter(([feedId]) => requested.has(feedId))
      .map(([feedId, completed]) => ({
        type: "frame" as const,
        payload: { feedId, frame: completed.frame, metrics: completed.metrics },
      }));
  }

  getProcessingHealth(): ProcessingHealth {
    const clientStats = this.clients.map((client) => client.stats);
    const spectrumFramesReceived = clientStats.reduce((total, stats) => total + stats.spectrumFramesReceived, 0);
    const spectrumFramesEmitted = clientStats.reduce((total, stats) => total + stats.spectrumFramesEmitted, 0);
    return {
      spectrumFramesReceived: spectrumFramesReceived || this.spectrumFramesAnalyzed,
      spectrumFramesAnalyzed: this.spectrumFramesAnalyzed,
      spectrumFramesDropped: clientStats.reduce((total, stats) => total + stats.spectrumFramesDropped, 0)
        + Math.max(0, spectrumFramesEmitted - this.spectrumFramesAnalyzed),
      tuneGateFramesIgnored: clientStats.reduce((total, stats) => total + stats.tuneGateFramesIgnored, 0),
      tuneFramesDiscarded: clientStats.reduce((total, stats) => total + stats.tuneFramesDiscarded, 0),
      rateCoalescedFrames: clientStats.reduce((total, stats) => total + stats.rateCoalescedFrames, 0),
      invalidSpectrumFramesDropped: clientStats.reduce((total, stats) => total + stats.invalidSpectrumFramesDropped, 0)
        + this.rejectedRfEpochFrames,
      acceptedAttributionInvariantViolations: this.acceptedAttributionInvariantViolations,
      unexpectedIqPayloadsDropped: clientStats.reduce((total, stats) => total + stats.unexpectedIqPayloadsDropped, 0),
      evidenceFramesRecorded: this.evidenceFramesRecorded,
      evidenceFramesDropped: this.evidenceFramesDropped,
      evidenceWritesInFlight: this.evidenceWritesInFlight,
      maxSpectrumRateHz: this.config.maxSpectrumRateHz,
      maxSpectrumBins: this.config.maxSpectrumBins,
      evidenceFrameIntervalMs: this.config.evidenceFrameIntervalMs,
    };
  }

  getBaselineStates(): BaselineDescriptor[] {
    return (this.baselineStore?.list() ?? []).map((descriptor) => this.publicBaselineDescriptor(descriptor));
  }

  getBaselineApprovalEligibility(): BaselineApprovalEligibility[] {
    return this.getBaselineStates().map((baseline) => this.baselineApprovalEligibility(baseline));
  }

  getProtectedBaselineReadiness(): { ready: boolean; requiredTargetIds: string[]; pendingTargetIds: string[] } {
    const requiredTargetIds = [...new Set(this.assignments.flatMap((assignment) => assignment.targets)
      .filter((target) => target.tier === "tier1")
      .map((target) => target.physicalTargetId ?? target.id))].sort();
    const descriptors = this.baselineStore?.list() ?? [];
    const pendingTargetIds = requiredTargetIds.filter((targetId) => {
      const fingerprintId = this.activeBaselineFingerprintIdByTarget.get(targetId);
      if (!fingerprintId) return true;
      const latest = descriptors
        .filter((descriptor) => descriptor.targetId === targetId && descriptor.fingerprintId === fingerprintId)
        .sort((left, right) => right.generation - left.generation)[0];
      return latest?.lifecycle !== "protected";
    });
    return { ready: requiredTargetIds.length > 0 && pendingTargetIds.length === 0, requiredTargetIds, pendingTargetIds };
  }

  getBaselineAllocationBytes(): number {
    return (this.baselineStore?.getAllocationBytes() ?? 0) + this.detector.getAllocationBytes();
  }

  getRingAllocationBytes(): number {
    return [...this.spectrumRingByReceiver.values()].reduce(
      (total, frames) => total + frames.reduce((frameTotal, frame) => frameTotal + frame.bins.byteLength, 0),
      0,
    );
  }

  getWriterHealth(): { queueItems: number; queueBytes: number; oldestAgeMs: number; diskWriteBytesPerSecond10s: number } {
    const now = Date.now();
    while (this.evidenceWriteSamples[0] && now - this.evidenceWriteSamples[0].at > 10_000) this.evidenceWriteSamples.shift();
    const writer = this.evidence.getWriterHealth(now);
    return {
      queueItems: writer.queueItems,
      queueBytes: writer.queueBytes,
      oldestAgeMs: writer.oldestAgeMs,
      diskWriteBytesPerSecond10s: Math.round(this.evidenceWriteSamples.reduce((total, sample) => total + sample.bytes, 0) / 10),
    };
  }

  getEvidenceArchiveHealth(): EvidenceArchiveHealth {
    const currentSession = this.evidence.currentSession;
    const sessions = [
      ...(currentSession ? [currentSession] : []),
      ...this.sessionList.filter((session) => session.id !== currentSession?.id),
    ];
    const finalizer = this.evidence.getFinalizerHealth();
    const finalizingSessions = sessions.filter((session) => session.lifecycle === "Finalizing").length;
    const incomplete = sessions.filter((session) => session.lifecycle === "Incomplete");
    const corrupt = sessions.filter((session) => session.lifecycle === "Corrupt" || session.status === "storage-error");
    const verified = sessions
      .filter((session) => session.verification?.verifiedAt)
      .sort((left, right) => (right.verification?.verifiedAt ?? "").localeCompare(left.verification?.verifiedAt ?? ""))[0];
    const issueSessionId = corrupt[0]?.id ?? incomplete[0]?.id ?? finalizer.lastFailure?.sessionId;
    return {
      state: issueSessionId ? "attention" : "normal",
      ...(currentSession ? { activeSessionId: currentSession.id } : {}),
      finalizingSessions,
      incompleteSessions: incomplete.length,
      corruptSessions: corrupt.length,
      ...(issueSessionId ? { issueSessionId } : {}),
      action: "open-recording",
      verificationNotRunSessions: sessions.filter((session) => (
        (session.lifecycle === "Complete" || session.lifecycle === "Incomplete")
        && (session.verification?.outcome ?? "not-run") === "not-run"
      )).length,
      ...(verified?.verification ? { lastVerification: { sessionId: verified.id, ...verified.verification } } : {}),
      finalizer,
    };
  }

  getSchedulerHealth(): SchedulerHealth {
    const completionHistory = this.assignments.flatMap((assignment) => assignment.scheduler.getCompletionHistory());
    const missHistory = this.assignments.flatMap((assignment) => assignment.scheduler.getMissHistory());
    const now = performance.now();
    const snapshots = this.assignments.map((assignment) => assignment.scheduler.snapshot(now));
    const optionalTargets = snapshots.flatMap((snapshot) => snapshot.targets.filter((target) => target.tier !== "tier1"));
    const tierOneTargets = snapshots.flatMap((snapshot) => snapshot.targets.filter((target) => target.tier === "tier1"));
    const tier1ValidRevisits = tierOneTargets.reduce((total, target) => total + target.validRevisits, 0);
    const tier1OnTimeRevisits = tierOneTargets.reduce((total, target) => total + target.onTimeValidRevisits, 0);
    const tier1OnTimeRatio = tier1ValidRevisits ? tier1OnTimeRevisits / tier1ValidRevisits : undefined;
    const tier1CoverageMeasured = tierOneTargets.length > 0
      && tierOneTargets.every((target) => target.validRevisits > 0);
    const tierOneCompletions = completionHistory.filter((record) => record.tier === "tier1" && record.valid);
    const tierOneUtilization = snapshots.reduce((maximum, snapshot) => Math.max(maximum, snapshot.tierOneUtilization), 0);
    const optionalSchedulers = snapshots.filter((snapshot) => snapshot.targets.some((target) => target.tier !== "tier1"));
    // Optional qualification is vacuously complete when this configuration has
    // no optional targets. It must never block qualification of a Tier-1-only
    // monitoring mission.
    const optionalQualificationReady = optionalSchedulers.length === 0
      || optionalSchedulers.every((snapshot) => snapshot.optionalQualificationReady);
    const coverageTargets = tierOneTargets.length > 0
      ? tierOneTargets
      : snapshots.flatMap((snapshot) => snapshot.targets);
    const coverageTargetIds = new Set(coverageTargets.map((target) => target.id));
    const recentCutoff = now - 60_000;
    const recentMiss = missHistory.filter((record) => (
      coverageTargetIds.has(record.targetId) && record.completedAtMs >= recentCutoff
    )).at(-1);
    const recentUnknown = completionHistory.filter((record) => (
      coverageTargetIds.has(record.targetId) && !record.valid && record.completedAtMs >= recentCutoff
    )).at(-1);
    const overdue = coverageTargets.filter((target) => (
      target.currentUnobservedGapMs !== undefined
      && target.currentUnobservedGapMs > target.revisitObjectiveMs
    )).sort((left, right) => (
      (right.currentUnobservedGapMs! - right.revisitObjectiveMs)
      - (left.currentUnobservedGapMs! - left.revisitObjectiveMs)
    ))[0];
    const awaitingMeasurement = coverageTargets.find((target) => target.validRevisits === 0);
    const currentCoverage: NonNullable<SchedulerHealth["currentCoverage"]> = overdue
      ? {
          state: "late",
          windowMs: 60_000,
          targetId: overdue.id,
          objectiveMs: overdue.revisitObjectiveMs,
          measuredRevisitMs: overdue.currentUnobservedGapMs,
          cause: "current-gap-overdue",
        }
      : recentMiss
        ? {
            state: "late",
            windowMs: 60_000,
            targetId: recentMiss.targetId,
            objectiveMs: recentMiss.revisitObjectiveMs,
            ...(recentMiss.revisitMs !== undefined ? { measuredRevisitMs: recentMiss.revisitMs } : {}),
            cause: "recent-objective-miss",
          }
        : recentUnknown
          ? {
              state: "checking",
              windowMs: 60_000,
              targetId: recentUnknown.targetId,
              objectiveMs: recentUnknown.revisitObjectiveMs,
              ...(recentUnknown.revisitMs !== undefined ? { measuredRevisitMs: recentUnknown.revisitMs } : {}),
              cause: "recent-unknown-visit",
            }
          : awaitingMeasurement || coverageTargets.length === 0
            ? {
                state: "checking",
                windowMs: 60_000,
                ...(awaitingMeasurement ? {
                  targetId: awaitingMeasurement.id,
                  objectiveMs: awaitingMeasurement.revisitObjectiveMs,
                  ...(awaitingMeasurement.currentUnobservedGapMs !== undefined ? { measuredRevisitMs: awaitingMeasurement.currentUnobservedGapMs } : {}),
                } : {}),
                cause: "awaiting-revisit-measurement",
              }
            : { state: "on-time", windowMs: 60_000 };
    return {
      profile: this.config.operationalSettings.scan.profile,
      configurationEpoch: this.configurationEpoch,
      tuneEpoch: Math.max(this.syntheticTuneEpoch, ...this.assignments.map((assignment) => assignment.active?.visit.tuneEpoch ?? 0)),
      activeVisit: this.assignments.find((assignment) => assignment.active)?.active?.visit,
      // Histories are intentionally bounded samples. Operational totals must
      // come from the scheduler's monotonic counters or they would shrink once
      // an old visit ages out of the ring.
      completedVisits: snapshots.flatMap((snapshot) => snapshot.targets)
        .reduce((total, target) => total + target.validCompletions, 0),
      unknownVisits: snapshots.flatMap((snapshot) => snapshot.targets)
        .reduce((total, target) => total + target.failedVisits, 0),
      missedObjectives: snapshots.flatMap((snapshot) => snapshot.targets)
        .reduce((total, target) => total + target.missedRevisits, 0),
      tier1ValidRevisits,
      tier1OnTimeRatio,
      lastMissCause: missHistory.at(-1)?.missCause ?? missHistory.at(-1)?.completionCause,
      // Do not call the profile Meeting objective while one of its Tier-1
      // targets still has no real completion-to-completion measurement.
      tier1MeetingObjective: !tier1CoverageMeasured || tier1OnTimeRatio === undefined
        ? undefined
        : tier1OnTimeRatio >= 0.999,
      currentCoverage,
      maximumTier1RevisitMs: tierOneCompletions.reduce((maximum, record) => Math.max(maximum, record.revisitMs ?? 0), 0) || undefined,
      maximumTier1UnobservedGapMs: tierOneCompletions.reduce((maximum, record) => Math.max(maximum, record.actualUnobservedGapMs ?? 0), 0) || undefined,
      optionalQualificationReady,
      optionalQualificationElapsedMs: optionalSchedulers.length
        ? Math.min(...optionalSchedulers.map((snapshot) => snapshot.optionalQualificationElapsedMs))
        : 0,
      optionalWorkAdmitted: optionalTargets.length > 0 && optionalQualificationReady && tierOneUtilization <= 0.9,
      protectedReserveRatio: 0.1,
    };
  }

  getTargetTimingHealth(): TargetTimingHealth[] {
    const percentile = (values: number[], ratio: number): number | undefined => {
      if (!values.length) return undefined;
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
    };
    const distribution = (values: number[]) => {
      const bounded = values.slice(-1_024);
      return {
        samples: bounded.length,
        last: bounded.at(-1),
        p50: percentile(bounded, 0.5),
        p95: percentile(bounded, 0.95),
        p99: percentile(bounded, 0.99),
        maximum: bounded.length ? Math.max(...bounded) : undefined,
      };
    };
    return this.assignments.flatMap((assignment) => {
      const schedulerTargets = new Map(assignment.scheduler.snapshot().targets.map((target) => [target.id, target]));
      return assignment.targets.map((target) => {
        const targetHistory = this.timingHistoryByTarget.get(target.id) ?? [];
        const exact = schedulerTargets.get(target.id);
        const causes = this.timingCauseTotalsByTarget.get(target.id) ?? { misses: {}, unknowns: {} };
        const histograms = this.timingHistogramsByTarget.get(target.id) ?? {
          revisitCounts: COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS.map(() => 0),
          revisitOverflow: 0,
          revisitSamples: 0,
          gapCounts: COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS.map(() => 0),
          gapOverflow: 0,
          gapSamples: 0,
        };
        return {
          commissioningEpochId: this.commissioningEpochId,
          targetId: target.physicalTargetId ?? target.id,
          objectiveMs: target.revisitObjectiveMs ?? target.dwellMs,
          revisitMs: distribution(targetHistory.flatMap((record) => record.revisitMs === undefined ? [] : [record.revisitMs])),
          unobservedGapMs: distribution(targetHistory.flatMap((record) => record.actualUnobservedGapMs === undefined ? [] : [record.actualUnobservedGapMs])),
          revisitHistogram: {
            boundsMs: [...COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS],
            counts: [...histograms.revisitCounts],
            overflow: histograms.revisitOverflow,
            samples: histograms.revisitSamples,
          },
          unobservedGapHistogram: {
            boundsMs: [...COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS],
            counts: [...histograms.gapCounts],
            overflow: histograms.gapOverflow,
            samples: histograms.gapSamples,
          },
          validCompletions: exact?.validCompletions ?? 0,
          validRevisits: exact?.validRevisits ?? 0,
          objectiveMetRevisits: exact?.onTimeValidRevisits ?? 0,
          objectiveMissedRevisits: exact?.lateValidRevisits ?? 0,
          objectiveBreaches: exact?.missedRevisits ?? 0,
          // Compatibility aliases remain exact even after the bounded
          // percentile reservoir reaches 1,024 samples.
          completedVisits: exact?.validCompletions ?? 0,
          unknownVisits: exact?.failedVisits ?? 0,
          missedObjectives: exact?.missedRevisits ?? 0,
          missesByCause: { ...causes.misses },
          unknownsByCause: { ...causes.unknowns },
        } satisfies TargetTimingHealth;
      });
    });
  }

  getCommissioningHealth(): CommissioningHealth {
    const now = performance.now();
    const scheduler = this.getSchedulerHealth();
    const qualificationActive = now >= this.commissioningStartedAtMonotonicMs;
    // auto is deliberately a test-domain mode even when a receiver happens to
    // connect. Only an explicit simulation=off process may qualify field data.
    const simulation = this.config.dataDomain === "test";
    const receiverReady = this.receiverStates.length > 0 && this.receiverStates.every((receiver) => receiver.streamReady && receiver.deviceReady);
    const fingerprintMetadataReady = this.config.dataDomain === "test" || (this.receiverStates.length > 0
      && this.receiverStates.every((_, receiverId) => this.fingerprintHealthComplete(receiverId, "sdrconnect")));
    const sampleRateReady = this.receiverStates.length > 0
      && this.receiverStates.every((receiver) => receiver.confirmedSampleRateHz === this.config.sampleRateHz);
    const soakElapsedMs = Math.max(0, now - this.commissioningStartedAtMonotonicMs);
    const schedulerTargets = this.assignments.flatMap((assignment) => assignment.scheduler.snapshot().targets);
    const tier1Targets = schedulerTargets.filter((target) => target.tier === "tier1");
    const qualificationTargets = tier1Targets.length ? tier1Targets : schedulerTargets;
    if (qualificationActive && this.paused) this.commissioningFaults.add("monitoring-paused");
    const coverageCurrentlyLate = qualificationActive && qualificationTargets.some((target) => {
      const latestValidAt = this.commissioningLastValidCompletionByTarget.get(target.id)
        ?? this.commissioningStartedAtMonotonicMs;
      return now - latestValidAt > target.revisitObjectiveMs;
    });
    const qualificationTimingFault = [...this.commissioningFaults].some((fault) => (
      fault.startsWith("unknown-visit:") || fault.startsWith("tier1-objective-miss:")
    ));
    const scanObjectiveReady = qualificationTargets.length > 0
      && qualificationTargets.every((target) => {
        const validRevisits = this.commissioningValidRevisitsByTarget.get(target.id) ?? 0;
        const onTimeRevisits = this.commissioningOnTimeRevisitsByTarget.get(target.id) ?? 0;
        return validRevisits > 0 && onTimeRevisits / validRevisits >= 0.999;
      })
      && !coverageCurrentlyLate
      && !qualificationTimingFault;
    const resourceSoakClean = this.commissioningFaults.size === 0
      && this.evidenceFramesDropped === this.commissioningEvidenceFramesDroppedAtStart
      && this.evidenceHealthy;
    const faults = [
      ...this.commissioningFaults,
      ...(!fingerprintMetadataReady && qualificationActive ? ["rf-fingerprint-metadata-unavailable"] : []),
    ].sort();
    const invalidated = qualificationActive && (!resourceSoakClean || faults.length > 0);
    const ready = !simulation
      && receiverReady
      && fingerprintMetadataReady
      && sampleRateReady
      && scanObjectiveReady
      && resourceSoakClean
      && soakElapsedMs >= MonitorService.COMMISSIONING_SOAK_MS;
    return {
      epochId: this.commissioningEpochId,
      state: simulation
        ? "simulation"
        : !receiverReady
          ? "receiver-pending"
          : invalidated
            ? "invalidated"
            : ready
              ? "qualified"
              : soakElapsedMs > 0
                ? "qualifying"
                : "rf-flow-ready",
      ready,
      receiverReady,
      sampleRateReady,
      simulation,
      dataDomain: this.config.dataDomain,
      soakRequiredMs: MonitorService.COMMISSIONING_SOAK_MS,
      soakElapsedMs,
      soakStartedAt: new Date(this.commissioningStartedAtWallMs).toISOString(),
      scanObjectiveReady,
      resourceSoakClean,
      // SDRconnect properties arrive asynchronously at startup. Missing RF
      // fingerprint metadata is preparation state during the bounded warm-up,
      // not a qualification fault. Once the qualification clock starts, a
      // missing or subsequently lost fingerprint is a real sticky fault.
      faults,
    };
  }

  noteResourceHealth(health: ResourceHealth): void {
    const previousResourceState = this.resourceHealthState;
    const changed = this.resourcePressureActive !== (health.state !== "normal")
      || this.resourceDashboardsStatusOnly !== health.dashboardsStatusOnly;
    this.resourceHealthState = health.state;
    this.resourcePressureActive = health.state !== "normal";
    this.hostMemoryPressureActive = health.hostMemory?.state === "pressure" || health.hostMemory?.state === "critical";
    this.resourceDashboardsStatusOnly = health.dashboardsStatusOnly;
    if (changed) this.broadcastSnapshot();
    if (previousResourceState !== "normal" && health.state === "normal") this.restartCommissioningEpoch();
    if (health.hostMemory?.state === "critical" || health.hostMemory?.recentOomKill) this.commissioningFaults.add("host-memory-critical");
    if (performance.now() < this.commissioningStartedAtMonotonicMs) return;
    if (health.state !== "normal") this.commissioningFaults.add(`resource-${health.state}`);
  }

  async approveBaseline(input: {
    targetId: string;
    expectedFingerprintId: string;
    expectedGeneration: number;
    approvedBy: string;
  }): Promise<BaselineDescriptor> {
    if (!this.baselineStore) throw new Error("Baseline store is unavailable");
    const approval = this.getBaselineApprovalEligibility().find((candidate) => (
      candidate.targetId === input.targetId
      && candidate.fingerprintId === input.expectedFingerprintId
      && Number(candidate.learningGenerationId) === input.expectedGeneration
    ));
    if (!approval) throw new Error("The exact active baseline fingerprint is unavailable; wait for a valid visit and reload");
    if (!approval.eligible) throw new BaselineApprovalUnavailableError(approval);
    const fingerprint = this.activeBaselineFingerprints.get(`${input.targetId}:${input.expectedFingerprintId}`);
    if (!fingerprint) throw new Error("The exact active baseline fingerprint is unavailable; wait for a valid visit and reload");
    const descriptor = this.baselineStore.approve({
      fingerprint,
      expectedFingerprintId: input.expectedFingerprintId,
      expectedGeneration: input.expectedGeneration,
      approvedBy: input.approvedBy,
    });
    await this.baselineStore.flush();
    if (this.evidenceHealthy) await this.evidence.recordOperationalAction({
      type: "baseline-protected",
      timestamp: new Date().toISOString(),
      targetId: input.targetId,
      fingerprintId: descriptor.fingerprintId,
      generation: descriptor.generation,
      approvedBy: input.approvedBy,
    });
    this.broadcastSnapshot();
    return this.publicBaselineDescriptor(descriptor);
  }

  private baselineApprovalEligibility(
    baseline: BaselineDescriptor,
  ): BaselineApprovalEligibility {
    const common = {
      targetId: baseline.targetId,
      fingerprintId: baseline.fingerprintId,
      learningGenerationId: baseline.learningGenerationId,
    };
    if (baseline.lifecycle === "protected") return { ...common, eligible: false, state: "approved", label: "Approved" };
    if (baseline.lifecycle !== "reviewable") return { ...common, eligible: false, state: "learning", label: "Learning" };
    if (this.config.dataDomain !== "field") {
      return { ...common, eligible: false, state: "blocked", label: "Test data", detail: "Field data is required.", action: "Use Live field data." };
    }
    const receiverReady = getMonitoringReadiness(this.receiverStates).ready;
    if (!receiverReady) {
      return { ...common, eligible: false, state: "blocked", label: "Receiver offline", detail: "RF data is unavailable.", action: "Restore RF data." };
    }
    const writer = this.getWriterHealth();
    if (!this.evidenceHealthy || this.storageMaintenance.pressure || writer.oldestAgeMs >= 2_000 || writer.queueItems >= WRITER_ORDINARY_MAX_ITEMS || writer.queueBytes >= WRITER_ORDINARY_MAX_BYTES) {
      return { ...common, eligible: false, state: "blocked", label: "Recording issue", detail: "Current evidence recording is not healthy.", action: "Open Recording." };
    }
    if (this.resourceHealthState !== "normal" || this.hostMemoryPressureActive || this.applicationRecoveryActive || this.receiverRecoveryActive) {
      return { ...common, eligible: false, state: "blocked", label: "System issue", detail: "Wait for current system recovery to finish.", action: "Open System health." };
    }
    const targetState = this.targetStates.get(baseline.targetId);
    if (targetState && (targetState.candidateCount > 0 || targetState.lifecycle === "active" || targetState.lifecycle === "recovering")) {
      return { ...common, eligible: false, state: "checking", label: "Checking", detail: "Wait for the current signal check to clear.", action: "Wait." };
    }
    if (!this.activeBaselineFingerprints.has(`${baseline.targetId}:${baseline.fingerprintId}`)) {
      return { ...common, eligible: false, state: "checking", label: "Checking", detail: "Waiting for current RF data.", action: "Wait." };
    }
    return { ...common, eligible: true, state: "eligible", label: "Ready for review", detail: "Confirm this period is suitable as the local reference." };
  }

  async restartBaseline(input: {
    targetId: string;
    expectedFingerprintId: string;
    expectedGeneration: number;
    restartedBy: string;
  }): Promise<BaselineRestartResult> {
    if (!this.baselineStore) throw new Error("Baseline store is unavailable");
    if (this.syntheticExercise) throw new Error("Finish the simulation test before restarting signal learning");
    const currentState = this.targetStates.get(input.targetId);
    if (currentState && (["active", "recovering"].includes(currentState.lifecycle) || currentState.candidateCount > 0)) {
      throw new Error("Wait for the active or recovering observation to clear before restarting signal learning");
    }
    const fingerprint = this.activeBaselineFingerprints.get(`${input.targetId}:${input.expectedFingerprintId}`);
    if (!fingerprint) throw new Error("The exact active baseline fingerprint is unavailable; wait for a valid visit and reload");
    const pending = await readBaselineRestartOperation(this.config.dataRoots, this.config.dataDomain);
    if (pending) {
      if (pending.targetId !== input.targetId
          || pending.fingerprintId !== input.expectedFingerprintId
          || pending.expectedGeneration !== input.expectedGeneration) {
        throw new Error(`Signal learning restart ${pending.operationId} requires recovery before another target can be changed`);
      }
      const recovered = await this.repairBaselineRestartOperation();
      if (recovered) return recovered;
    }
    if (this.baselineRestartTargets.size > 0 || this.baselineRestartTargets.has(input.targetId)) {
      throw new Error("Signal learning restart is already in progress");
    }
    const targetRecords = this.baselineStore.list(input.targetId);
    const nextGeneration = targetRecords.reduce((maximum, descriptor) => Math.max(maximum, descriptor.generation), 0) + 1;
    const binCount = Number(fingerprint.analysisEndBin) - Number(fingerprint.analysisStartBin);
    const operation: BaselineRestartOperation = {
      schemaVersion: 1,
      type: "baseline-restart",
      operationId: randomUUID(),
      dataDomain: this.config.dataDomain,
      targetId: input.targetId,
      fingerprintId: input.expectedFingerprintId,
      expectedGeneration: input.expectedGeneration,
      nextGeneration,
      binCount,
      actor: input.restartedBy,
      preparedAt: new Date().toISOString(),
      phase: "prepared",
    };
    this.baselineRestartTargets.add(input.targetId);
    let descriptor: StoredBaselineDescriptor | undefined;
    try {
      await writeBaselineRestartOperation(this.config.dataRoots, operation);
      await this.serviceOptions.injectAtomicityFault?.("baseline-before-prepared-audit");
      await appendDomainMaintenanceAudit(this.config.dataRoots, {
        type: "baseline-restart-prepared",
        operationId: operation.operationId,
        dataDomain: operation.dataDomain,
        targetId: operation.targetId,
        fingerprintId: operation.fingerprintId,
        expectedGeneration: operation.expectedGeneration,
        nextGeneration: operation.nextGeneration,
        actor: operation.actor,
      });

      try {
        descriptor = await this.baselineStore.restartAndFlush(fingerprint, input.expectedGeneration);
      } catch (error) {
        if (error instanceof BaselineRestartCommitUncertainError) {
          descriptor = error.descriptor;
          // Keep the prepared journal and target gate. A retry/startup repair
          // will fsync and inspect the visible generation before choosing it.
          this.baselineHealthy = false;
          return {
            baseline: this.publicBaselineDescriptor(descriptor),
            operationId: operation.operationId,
            committed: true,
            state: "recovery-required",
            auditDurable: false,
            recoveryReason: error.message,
          };
        }
        await appendDomainMaintenanceAudit(this.config.dataRoots, {
          type: "baseline-restart-aborted",
          operationId: operation.operationId,
          dataDomain: operation.dataDomain,
          targetId: operation.targetId,
          reason: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        await removeBaselineRestartOperation(this.config.dataRoots, operation.dataDomain).catch(() => undefined);
        throw error;
      }

      // Persistent generation selection is the destructive commit point.
      try {
        await this.serviceOptions.injectAtomicityFault?.("baseline-after-persistent-commit");
        operation.phase = "baseline-committed";
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
        await this.serviceOptions.injectAtomicityFault?.("baseline-before-detector-reset");
        this.applyBaselineRestartRuntime(operation);
        operation.phase = "runtime-reset";
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
        await this.serviceOptions.injectAtomicityFault?.("baseline-before-completion-audit");
        await appendDomainMaintenanceAudit(this.config.dataRoots, {
          type: "baseline-learning-restarted",
          operationId: operation.operationId,
          dataDomain: operation.dataDomain,
          targetId: operation.targetId,
          fingerprintId: operation.fingerprintId,
          generation: operation.nextGeneration,
          restartedBy: operation.actor,
          committed: true,
        });
        operation.phase = "audited";
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
        await this.serviceOptions.injectAtomicityFault?.("baseline-before-journal-cleanup");
        await removeBaselineRestartOperation(this.config.dataRoots, operation.dataDomain);
      } catch (error) {
        this.baselineHealthy = false;
        this.broadcastSnapshot();
        return {
          baseline: this.publicBaselineDescriptor(descriptor),
          operationId: operation.operationId,
          committed: true,
          state: "recovery-required",
          auditDurable: operation.phase === "audited",
          recoveryReason: error instanceof Error ? error.message : String(error),
        };
      }

      if (this.evidenceHealthy) await this.evidence.recordOperationalAction({
        type: "baseline-learning-restarted",
        timestamp: new Date().toISOString(),
        targetId: input.targetId,
        fingerprintId: descriptor.fingerprintId,
        generation: descriptor.generation,
        restartedBy: input.restartedBy,
        operationId: operation.operationId,
      }).catch(() => undefined);
      this.baselineRestartTargets.delete(input.targetId);
      this.baselineHealthy = this.baselineRestartTargets.size === 0;
      this.broadcastSnapshot();
      return {
        baseline: this.publicBaselineDescriptor(descriptor),
        operationId: operation.operationId,
        committed: true,
        state: "complete",
        auditDurable: true,
      };
    } catch (error) {
      if (!descriptor) this.baselineRestartTargets.delete(input.targetId);
      throw error;
    }
  }

  private applyBaselineRestartRuntime(operation: BaselineRestartOperation): void {
    this.detector.resetTarget(
      operation.targetId,
      operation.fingerprintId,
      operation.dataDomain,
      String(operation.nextGeneration),
      operation.binCount,
    );
    this.lastBaselineTrainingAtByTarget.delete(operation.targetId);
    this.prehistoryCandidateTargets.delete(operation.targetId);
    this.postClearUntilByTarget.delete(operation.targetId);
    this.activeEventsByTarget.delete(operation.targetId);
    this.targetStates.set(operation.targetId, this.clearTargetState(operation.targetId));
    this.refreshActiveEvent();
  }

  /** Completes or aborts the one bounded restart journal for this domain. */
  private async repairBaselineRestartOperation(): Promise<BaselineRestartResult | undefined> {
    if (!this.baselineStore) throw new Error("Baseline store is unavailable");
    let operation = await readBaselineRestartOperation(this.config.dataRoots, this.config.dataDomain);
    if (!operation) return undefined;
    this.baselineRestartTargets.add(operation.targetId);
    const fingerprintId = operation.fingerprintId;
    const exact = this.baselineStore.list(operation.targetId)
      .filter((descriptor) => descriptor.fingerprintId === fingerprintId)
      .sort((left, right) => left.generation - right.generation);
    const selected = exact.at(-1);

    if (operation.phase === "prepared" && selected?.generation === operation.expectedGeneration) {
      await appendDomainMaintenanceAudit(this.config.dataRoots, {
        type: "baseline-restart-aborted",
        operationId: operation.operationId,
        dataDomain: operation.dataDomain,
        targetId: operation.targetId,
        reason: "persistent-commit-not-reached",
      });
      await removeBaselineRestartOperation(this.config.dataRoots, operation.dataDomain);
      this.baselineRestartTargets.delete(operation.targetId);
      this.baselineHealthy = this.baselineRestartTargets.size === 0;
      return undefined;
    }

    if (selected?.generation !== operation.nextGeneration) {
      this.baselineHealthy = false;
      throw new CommittedBaselineRestartRecoveryError(
        operation,
        `Baseline restart ${operation.operationId} cannot select generation ${selected?.generation ?? "missing"}; expected ${operation.nextGeneration}. Signal learning remains Checking.`,
      );
    }

    try {
      // This also resolves the case where rename succeeded but its parent
      // directory fsync failed during the original request.
      await this.baselineStore.confirmStorageDurability();
      if (operation.phase === "prepared") {
        operation = { ...operation, phase: "baseline-committed" };
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
      }
      this.applyBaselineRestartRuntime(operation);
      if (operation.phase === "baseline-committed") {
        operation = { ...operation, phase: "runtime-reset" };
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
      }
      if (operation.phase === "runtime-reset") {
        await appendDomainMaintenanceAudit(this.config.dataRoots, {
          type: "baseline-learning-restarted",
          operationId: operation.operationId,
          dataDomain: operation.dataDomain,
          targetId: operation.targetId,
          fingerprintId: operation.fingerprintId,
          generation: operation.nextGeneration,
          restartedBy: operation.actor,
          committed: true,
          recovered: true,
        });
        operation = { ...operation, phase: "audited" };
        await writeBaselineRestartOperation(this.config.dataRoots, operation);
      }
      await removeBaselineRestartOperation(this.config.dataRoots, operation.dataDomain);
      this.baselineRestartTargets.delete(operation.targetId);
      this.baselineHealthy = this.baselineRestartTargets.size === 0;
      return {
        baseline: this.publicBaselineDescriptor(selected),
        operationId: operation.operationId,
        committed: true,
        state: "complete",
        auditDurable: true,
      };
    } catch (error) {
      this.baselineHealthy = false;
      return {
        baseline: this.publicBaselineDescriptor(selected),
        operationId: operation.operationId,
        committed: true,
        state: "recovery-required",
        auditDurable: operation.phase === "audited",
        recoveryReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Clears test-only recordings and learning without touching the field tree. */
  async clearTestData(clearedBy: string): Promise<TestDataClearResult> {
    if (this.syntheticExercise) throw new Error("Finish the simulation test before clearing test data");
    if (this.reconfiguring) throw new Error("Wait for the current settings or data operation to finish");
    if (this.config.dataDomain === "field") {
      const result = await clearTestDomain(this.config.dataRoots, clearedBy);
      return { ...result, runtimeState: result.state === "complete" ? "active" : "recovery-required" };
    }

    this.reconfiguring = true;
    let resumeScheduling = false;
    try {
      for (const assignment of this.assignments) {
        if (assignment.timer) clearTimeout(assignment.timer);
        assignment.active = undefined;
      }
      await this.evidence.flush();
      if (this.evidence.currentSession) await this.evidence.closeActive();
      await this.baselineStore?.close();
      await this.domainLease?.release();
      this.domainLease = undefined;
      let result: ClearedTestData;
      try {
        result = await clearTestDomain(this.config.dataRoots, clearedBy);
      } catch (error) {
        // Every thrown clear error is pre-commit. Reopen the unchanged tree,
        // then preserve the original error for the protected API.
        await this.openTestRuntime("test-data-clear-precommit-recovery");
        resumeScheduling = true;
        throw error;
      }

      if (result.state === "recovery-required") {
        try {
          const recovered = await repairInterruptedTestClear(this.config.dataRoots);
          if (recovered.result) result = recovered.result;
        } catch (error) {
          return {
            ...result,
            state: "recovery-required",
            runtimeState: "recovery-required",
            recoveryReason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      try {
        await this.serviceOptions.injectAtomicityFault?.("clear-before-runtime-reopen");
        await this.openTestRuntime("test-data-cleared");
        resumeScheduling = true;
        await this.serviceOptions.injectAtomicityFault?.("clear-after-runtime-reopen");
      } catch (error) {
        return {
          ...result,
          state: "recovery-required",
          runtimeState: "recovery-required",
          recoveryReason: error instanceof Error ? error.message : String(error),
        };
      }
      await this.evidence.recordOperationalAction({
        type: "test-data-cleared",
        operationId: result.operationId,
        clearedBy,
        clearedAt: result.clearedAt,
      }).catch(() => undefined);
      return { ...result, runtimeState: "active" };
    } finally {
      this.reconfiguring = false;
      if (resumeScheduling) this.scheduleAllAssignments();
      this.broadcastSnapshot();
    }
  }

  private async openTestRuntime(reason: string): Promise<void> {
    await ensureDomainRoot(this.config.dataRoots.test.root, "test");
    this.domainLease = await acquireDataDomainLease(this.config.dataRoots.test.root, "test");
    this.evidence = new EvidenceStore(this.config.dataRoots.test.evidenceRoot, { dataDomain: "test" });
    this.baselineStore = await BaselineStore.open({
      filePath: this.config.dataRoots.test.baselineFile,
      dataDomain: "test",
      reservoirCapacity: this.config.detectionThresholds.reservoirSize,
      provisionalMinimumMs: this.config.detectionThresholds.minimumLearningMs,
      maxTargets: 32,
      injectAtomicWriteFault: () => this.serviceOptions.injectAtomicityFault?.("baseline-after-file-rename"),
    });
    this.detector = new DetectionEngine(this.config.detectionThresholds);
    this.resetDomainRuntimeState();
    this.configureAssignments();
    await this.evidence.initialize(this.sessionMetadata(reason));
    await this.refreshSessionList();
    this.evidenceHealthy = true;
    this.baselineHealthy = true;
  }

  async deleteRecordings(dataDomain: "field" | "test", deletedBy: string): Promise<RecordingDeletionResult> {
    if (dataDomain !== this.config.dataDomain) {
      throw new Error(`Recording deletion requested ${dataDomain} data while ${this.config.dataDomain} is active`);
    }
    if (this.reconfiguring) throw new Error("Wait for the current settings or data operation to finish");
    this.reconfiguring = true;
    try {
      await this.waitForStorageMaintenance();
      const result = await this.evidence.deleteRecordings(deletedBy);
      await this.refreshSessionList();
      const survivingSessionIds = new Set([
        ...(this.evidence.currentSession ? [this.evidence.currentSession.id] : []),
        ...this.sessionList.map((session) => session.id),
      ]);
      this.events = this.events.filter((event) => (
        event.syntheticExercise
        || (event.sessionIds ?? [event.sessionId]).some((sessionId) => survivingSessionIds.has(sessionId))
      ));
      this.broadcastSnapshot();
      return result;
    } finally {
      this.reconfiguring = false;
    }
  }

  setPaused(paused: boolean): void {
    if (paused) this.clearSyntheticExercise();
    if (this.paused && !paused) this.sweepBuilders.clear();
    this.paused = paused;
    if (paused) {
      for (const assignment of this.assignments) {
        if (assignment.active) this.completeUnknownVisit(assignment, "configuration-changed");
        if (assignment.timer) clearTimeout(assignment.timer);
      }
    } else this.scheduleAllAssignments();
    this.broadcastSnapshot();
  }

  private buildOperatorSummary(input: {
    generatedAt: string;
    monitoringReady: boolean;
    monitorTargets: MonitorTarget[];
    targetStates: ChannelMonitorState[];
    currentSession?: EvidenceSession;
  }): OperatorSummaryV1 {
    const receiverOnline = this.receiverStates.some((receiver) => (
      receiver.connection === "simulated"
      || (receiver.hardwareState !== "absent" && (
        receiver.socketConnected
        || receiver.apiReady
        || receiver.deviceReady
        || receiver.connection === "live"
        || receiver.connection === "stale"
      ))
    ));
    const candidateActive = input.targetStates.some((state) => state.candidateCount > 0 && state.lifecycle === "detecting");
    const baselineDescriptors = this.getBaselineStates();
    const activeBaselineLifecycle = (targetId: string): BaselineDescriptor["lifecycle"] | undefined => {
      const fingerprintId = this.activeBaselineFingerprintIdByTarget.get(targetId);
      if (!fingerprintId) return undefined;
      return baselineDescriptors
        .filter((baseline) => baseline.targetId === targetId && baseline.fingerprintId === fingerprintId)
        .sort((left, right) => Number(right.learningGenerationId) - Number(left.learningGenerationId))[0]?.lifecycle;
    };
    const activeMonitorTargets = input.monitorTargets.filter((target) => target.coverageMode !== "paused" && target.coverageMode !== "unavailable");
    const signalLearningActive = activeMonitorTargets.some((target) => {
      const lifecycle = activeBaselineLifecycle(target.id);
      return lifecycle === undefined || lifecycle === "learning" || lifecycle === "provisional" || lifecycle === "stale";
    });
    const baselineReviewRequired = !signalLearningActive && activeMonitorTargets.some((target) => {
      return activeBaselineLifecycle(target.id) === "reviewable";
    });
    /*
     * A reviewable local reference has finished learning. The detector remains
     * fail-closed until it is explicitly protected, but operator copy must not
     * describe this human-review state as continued collection.
     */
    const unprotectedReferenceActive = activeMonitorTargets.some((target) => {
      if (target.coverageMode === "paused" || target.coverageMode === "unavailable") return false;
      return activeBaselineLifecycle(target.id) !== "protected";
    });
    const detectingActive = signalLearningActive
      || (!baselineReviewRequired && input.targetStates.some((state) => state.lifecycle === "detecting"));
    const recovering = input.targetStates.some((state) => state.lifecycle === "recovering")
      || this.activeEvent?.lifecycle === "recovering";
    const alertActive = input.targetStates.some((state) => state.lifecycle === "active")
      || this.activeEvent?.lifecycle === "active";
    const affectedTargetIds = new Set(input.targetStates
      // `detecting` with zero votes is the detector's fail-closed learning /
      // unknown state, not an affected RF target. Surface only a real
      // candidate, active event, or recovering event as affected.
      .filter((state) => state.candidateCount > 0 || state.lifecycle === "active" || state.lifecycle === "recovering")
      .map((state) => state.targetId));
    for (const targetId of this.activeEventsByTarget.keys()) affectedTargetIds.add(targetId);
    const validObservationStates = input.targetStates
      .filter((state): state is ChannelMonitorState & { lastObservedAt: string } => (
        Boolean(state.lastObservedAt) && Number.isFinite(Date.parse(state.lastObservedAt!))
      ));
    const lifecycleRank: Record<ChannelMonitorState["lifecycle"], number> = {
      active: 4,
      recovering: 3,
      detecting: 2,
      clear: 1,
    };
    const affectedObservationState = validObservationStates
      .filter((state) => affectedTargetIds.has(state.targetId))
      .sort((left, right) => (
        lifecycleRank[right.lifecycle] - lifecycleRank[left.lifecycle]
        || right.candidateCount - left.candidateCount
        || Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt)
      ))[0];
    const newestObservationState = validObservationStates
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt))[0];
    const eventTargetId = this.activeEvent?.targetId;
    const eventObservationState = eventTargetId
      ? validObservationStates.find((state) => state.targetId === eventTargetId)
      : undefined;
    // An active detector event owns the operator clock even when an unrelated
    // target was visited more recently. Otherwise prefer an affected
    // candidate/recovering target, then the newest valid target observation.
    const observationTargetId = eventTargetId
      ?? affectedObservationState?.targetId
      ?? newestObservationState?.targetId;
    const latestObservationAt = eventTargetId
      ? eventObservationState?.lastObservedAt
        ?? (Number.isFinite(Date.parse(this.activeEvent!.lastSeenAt)) ? this.activeEvent!.lastSeenAt : null)
      : affectedObservationState?.lastObservedAt ?? newestObservationState?.lastObservedAt ?? null;
    const coverage = !receiverOnline
      ? "unknown" as const
      : !input.monitoringReady
        ? "not-observed" as const
        : latestObservationAt
          ? "observed" as const
          : "not-observed" as const;
    const affectedTargets = input.monitorTargets
      .filter((target) => affectedTargetIds.has(target.id))
      .map((target) => ({
        id: target.id,
        label: target.label,
        frequencyLabel: `${(target.centerHz / 1_000_000).toFixed(3)} MHz`,
      }));
    if (this.activeEvent?.targetId && !affectedTargets.some((target) => target.id === this.activeEvent?.targetId)) {
      affectedTargets.push({
        id: this.activeEvent.targetId,
        label: this.activeEvent.affectedLabel ?? this.activeEvent.bandLabel,
        frequencyLabel: `${((this.activeEvent.affectedRangeHz[0] + this.activeEvent.affectedRangeHz[1]) / 2_000_000).toFixed(3)} MHz`,
      });
    }
    const event = this.activeEvent;
    const verdict = event?.kind === "overload"
      ? "Receiver overloaded"
      : event?.kind === "narrowband-spike"
        ? "Narrow RF anomaly"
        : "Suspected RF interference";
    const recordingState = !this.evidenceHealthy || input.currentSession?.status === "storage-error"
      ? "error" as const
      : input.currentSession?.status === "recording"
        ? "recording" as const
        : "stopped" as const;
    const currentHealthState = this.config.dataDomain === "test"
      ? "simulation" as const
      : !this.evidenceHealthy || this.storageMaintenance.pressure || this.resourceHealthState === "critical"
        ? "critical" as const
        : !input.monitoringReady || !this.baselineHealthy || this.resourceHealthState === "pressure"
          ? "attention" as const
          : "normal" as const;
    const baseInput: OperatorSummaryInput = {
      generatedAt: input.generatedAt,
      serverBuildId: this.config.runtimeIdentity.release.serverBuildId,
      dataDomain: this.config.dataDomain,
      monitoring: {
        receiverOnline,
        dataFresh: input.monitoringReady,
        paused: this.paused,
        alertActive,
        recovering,
        candidateActive,
        detectingActive,
        checking: this.operatorStatus(input.monitoringReady, input.monitorTargets) === "Checking",
        ...(baselineReviewRequired && unprotectedReferenceActive ? { reasonCode: "baseline-review-required", actionCode: "open-signal-learning" } : {}),
      },
      ...(event ? {
        incident: {
          id: event.id,
          lifecycle: event.lifecycle === "recovering" ? "recovering" : "active",
          verdict,
          observation: event.observed,
          recommendedAction: event.recommendedAction,
          evidenceStrength: event.evidenceStrength === "Medium" ? "Medium" : "Low",
          startedAt: event.startedAt,
          synthetic: Boolean(event.syntheticExercise),
        },
      } : {}),
      recording: { state: recordingState },
      currentHealth: { state: currentHealthState },
      productionQualification: {
        state: this.config.dataDomain === "test" ? "simulation" : "pending",
        ready: false,
      },
      affectedTargets,
      observation: {
        at: latestObservationAt,
        coverage,
        ...(latestObservationAt && observationTargetId ? { targetId: observationTargetId } : {}),
      },
    };
    const provisional = resolveOperatorSummary(baseInput);
    if (provisional.monitoring.state !== this.operatorMonitoringState) {
      this.operatorMonitoringState = provisional.monitoring.state;
      this.operatorMonitoringStateSince = input.generatedAt;
    }
    return resolveOperatorSummary({
      ...baseInput,
      monitoring: { ...baseInput.monitoring, since: this.operatorMonitoringStateSince },
    });
  }

  private operatorStatus(monitoringReady: boolean, targets: MonitorTarget[]): OperatorStatus {
    if (this.activeEvent) return "Alert";
    if (!monitoringReady || this.paused || !this.baselineHealthy) return "Checking";
    if (targets.some((target) => target.coverageMode === "stale")) return "Checking";
    const activeTargets = targets.filter((target) => target.coverageMode !== "paused" && target.coverageMode !== "unavailable");
    if (activeTargets.some((target) => !target.lastObservedAt)) return "Checking";
    const baselines = this.getBaselineStates();
    const unprotectedActiveTarget = activeTargets.some((target) => {
      const fingerprintId = this.activeBaselineFingerprintIdByTarget.get(target.id);
      if (!fingerprintId) return true;
      const latest = baselines
        .filter((baseline) => baseline.targetId === target.id && baseline.fingerprintId === fingerprintId)
        .sort((left, right) => Number(right.learningGenerationId) - Number(left.learningGenerationId))[0];
      return latest?.lifecycle !== "protected";
    });
    if (unprotectedActiveTarget) return "Checking";
    return "Normal";
  }

  private decorateMonitorTargets(targets: MonitorTarget[], monitoringReady: boolean, now: number): MonitorTarget[] {
    const activeTargetIds = new Set(this.receiverStates.flatMap((receiver) => receiver.activeWindowId ? [receiver.activeWindowId] : []));
    const exclusiveTargetId = this.activeFocus?.targetId;
    const exclusive = Boolean(this.activeFocus);
    const optionalWorkAdmitted = this.getSchedulerHealth().optionalWorkAdmitted;
    return targets.map((target) => {
      const state = this.targetStates.get(target.id);
      const lastObservedAt = state?.lastObservedAt;
      const observedMs = lastObservedAt ? Date.parse(lastObservedAt) : Number.NaN;
      const late = Number.isFinite(observedMs) && now - observedMs > Math.max(15_000, target.expectedRevisitMs * 2.5);
      const protectingGnss = this.config.operationalSettings.scan.profile === "fast-gnss" && !target.priority && !optionalWorkAdmitted;
      const coverageMode = !monitoringReady
        ? "unavailable" as const
        : this.paused
          ? "paused" as const
          : exclusive
            ? target.id === exclusiveTargetId ? "live" as const : "paused" as const
            : protectingGnss
              ? "paused" as const
            : late
              ? "stale" as const
              : "scanning" as const;
      const nextDueAt = !exclusive && !this.paused && Number.isFinite(observedMs)
        ? new Date(observedMs + target.expectedRevisitMs).toISOString()
        : undefined;
      return {
        ...target,
        coverageMode: activeTargetIds.has(target.id) && exclusive ? "live" : coverageMode,
        lastObservedAt,
        nextDueAt,
      };
    });
  }

  private getSweepCycles(feeds: MonitorFeed[], monitoringReady: boolean, now: number): SweepCycle[] {
    return feeds.filter((feed) => feed.kind === "stitched-sweep").map((feed) => {
      const builder = this.sweepBuilders.get(feed.id);
      const completed = this.completedSweeps.get(feed.id);
      const sourceSegments = builder ? [...builder.segments.values()] : completed?.segments ?? [];
      const segments = sourceSegments.map((segment) => ({
        targetId: segment.targetId,
        startHz: segment.startHz,
        endHz: segment.endHz,
        observedAt: segment.observedAt,
        sampleCount: segment.sampleCount,
      }));
      const pauseReason = this.paused
        ? "operator" as const
        : this.activeFocus
          ? "live-focus" as const
          : undefined;
      const status = !monitoringReady
        ? "unavailable" as const
        : pauseReason
          ? "paused" as const
          : builder
            ? "building" as const
            : completed
              ? "complete" as const
              : "building" as const;
      const completedSegments = builder?.segments.size ?? (completed ? feed.targetIds.length : 0);
      return {
        id: builder?.id ?? completed?.frame.id ?? feed.id,
        feedId: feed.id,
        status,
        startedAt: builder?.startedAt,
        lastCompletedAt: completed?.completedAt,
        pausedAt: pauseReason ? new Date(now).toISOString() : undefined,
        pauseReason,
        completedSegments,
        totalSegments: feed.targetIds.length,
        progress: feed.targetIds.length ? Math.round((completedSegments / feed.targetIds.length) * 100) : 0,
        elapsedMs: builder ? Math.max(0, now - Date.parse(builder.startedAt)) : 0,
        segments,
        stitchedFrame: completed?.frame,
        waterfall: completed?.waterfall ?? [],
      };
    });
  }

  private recordSweepFrame(frame: SpectrumFrame): void {
    if (this.paused || this.activeFocus) return;
    const band = this.config.bands.find((candidate) => candidate.id === frame.bandId);
    if (!band || (band.service !== "startrack" && band.service !== "4dx") || !frame.targetId) return;
    const feedId = "survey-" + band.service;
    const expectedTargetIds = this.getMonitorTargets().filter((target) => target.service === band.service).map((target) => target.id);
    if (!expectedTargetIds.includes(frame.targetId)) return;
    const builder = this.sweepBuilders.get(feedId) ?? {
      id: randomUUID(),
      feedId,
      startedAt: frame.timestamp,
      segments: new Map<string, SweepBuilderSegment>(),
    };
    const firstSegmentForTarget = !builder.segments.has(frame.targetId);
    builder.segments.set(frame.targetId, {
      targetId: frame.targetId,
      startHz: frame.startHz,
      endHz: frame.endHz,
      observedAt: frame.timestamp,
      sampleCount: frame.bins.length,
      bins: frame.bins,
      analysisStartBin: frame.analysisStartBin ?? 0,
      analysisEndBin: frame.analysisEndBin ?? frame.bins.length,
      receiver: frame.receiver,
      source: frame.source,
      calibrated: frame.calibrated,
    });
    this.sweepBuilders.set(feedId, builder);
    if (!expectedTargetIds.every((targetId) => builder.segments.has(targetId))) {
      if (firstSegmentForTarget) this.broadcastSnapshot();
      return;
    }
    const segments = [...builder.segments.values()].sort((left, right) => left.startHz - right.startHz);
    const startHz = Math.min(...segments.map((segment) => segment.startHz));
    const endHz = Math.max(...segments.map((segment) => segment.endHz));
    const completedAt = segments.map((segment) => segment.observedAt).sort().at(-1) ?? frame.timestamp;
    const stitched = stitchSweepBins(segments, startHz, endHz);
    const stitchedFrame: SpectrumFrame = {
      id: randomUUID(),
      timestamp: completedAt,
      receiver: segments[0]?.receiver ?? frame.receiver,
      bandId: feedId,
      scanWindowId: feedId,
      startHz,
      endHz,
      bins: stitched.bins,
      inputBinCount: segments.reduce((total, segment) => total + Math.max(0, segment.analysisEndBin - segment.analysisStartBin), 0),
      binning: "peak-preserving",
      analysisStartBin: stitched.analysisStartBin,
      analysisEndBin: stitched.analysisEndBin,
      analysisSpanHz: Math.round(((stitched.analysisEndBin - stitched.analysisStartBin) / STITCHED_SWEEP_BIN_COUNT) * (endHz - startHz)),
      captureSpanHz: endHz - startHz,
      source: segments.some((segment) => segment.source === "sdrconnect") ? "sdrconnect" : "simulation",
      calibrated: segments.every((segment) => segment.calibrated),
    };
    const metrics = this.relativeMetrics(stitchedFrame, this.receiverMetrics.get(stitchedFrame.receiver) ?? { overload: false });
    const previous = this.completedSweeps.get(feedId);
    this.completedSweeps.set(feedId, {
      frame: stitchedFrame,
      metrics,
      waterfall: [...(previous?.waterfall ?? []).slice(-30), stitchedFrame],
      completedAt,
      segments: segments.map(({ bins: _bins, receiver: _receiver, source: _source, calibrated: _calibrated, ...segment }) => segment),
    });
    this.sweepBuilders.delete(feedId);
    this.emit("message", { type: "frame", payload: { feedId, frame: stitchedFrame, metrics } } satisfies ServiceMessage);
    this.broadcastSnapshot();
  }

  async recordConfigurationAudit(entries: ConfigurationAuditEntry | ConfigurationAuditEntry[]): Promise<void> {
    if (!this.evidenceHealthy) return;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      await this.evidence.recordConfigurationAudit(entry).catch((error) => this.markStorageError(error));
    }
  }

  async reconfigure(nextConfig: AppConfig): Promise<MonitorSnapshot> {
    if (this.reconfiguring) throw new Error("A settings change is already being applied");
    this.clearSyntheticExercise();
    this.reconfiguring = true;
    const previous = this.config;
    try {
      // Stop asynchronous producers before establishing the evidence-session
      // boundary. Otherwise the high-priority close job can overtake queued
      // metadata and leave those old-session jobs to fail against no session.
      await this.waitForStorageMaintenance();
      if (this.activeFocus) await this.stopFocus("configuration-changed");
      for (const assignment of this.assignments) {
        if (assignment.timer) clearTimeout(assignment.timer);
        assignment.timer = undefined;
      }
      if (this.sessionContextTimer) {
        clearTimeout(this.sessionContextTimer);
        this.sessionContextTimer = undefined;
      }
      await this.evidence.flush();
      const interruptedAt = new Date().toISOString();
      const interruptedEvents = [...this.activeEventsByTarget.values()];
      for (const event of interruptedEvents) {
        event.lifecycle = "ended-unknown";
        event.endedAt = interruptedAt;
        event.endReason = "RF configuration changed before ten clean observations";
        if (this.evidenceHealthy) await this.persistEvent({ ...event }).catch((error) => this.markStorageError(error));
      }
      if (this.evidenceHealthy && (interruptedEvents.length || this.postClearUntilByTarget.size)) {
        await this.evidence.recordOperationalAction({
          type: "configuration-change-evidence-gap",
          timestamp: interruptedAt,
          interruptedEventIds: interruptedEvents.map((event) => event.id),
          interruptedPostClearTargetIds: [...this.postClearUntilByTarget.keys()],
        }).catch((error) => this.markStorageError(error));
      }
      if (this.evidence.currentSession) {
        await this.checkpointSessionContext("settings-change-closing");
        await this.evidence.closeActive();
      }
      this.config = nextConfig;
      if (JSON.stringify(previous.detectionThresholds) !== JSON.stringify(nextConfig.detectionThresholds)) {
        this.detector = new DetectionEngine(nextConfig.detectionThresholds);
      }
      this.configurationEpoch += 1;
      this.activeEvent = undefined;
      this.activeEventsByTarget.clear();
      this.currentFrame = undefined;
      this.currentMetrics = undefined;
      this.waterfall = [];
      this.waterfallByTarget.clear();
      this.frameByTarget.clear();
      this.metricsByTarget.clear();
      this.spectrumRingByReceiver.clear();
      this.prehistoryCandidateTargets.clear();
      this.prehistoryFrozenReceivers.clear();
      this.postClearUntilByTarget.clear();
      this.targetStates.clear();
      this.sweepBuilders.clear();
      this.completedSweeps.clear();
      this.frameCounters.clear();
      this.lastEvidenceFrameAtByTarget.clear();
      this.lastBaselineTrainingAtByTarget.clear();
      this.activeBaselineFingerprints.clear();
      this.activeBaselineFingerprintIdByTarget.clear();
      // Timing distributions and commissioning counters describe exactly one
      // immutable RF configuration epoch. Same-ID targets must not inherit
      // samples or evidence failures from the previous revision.
      this.timingHistoryByTarget.clear();
      this.timingCauseTotalsByTarget.clear();
      this.timingHistogramsByTarget.clear();
      this.acceptedAttributionInvariantViolations = 0;
      this.measuredPriorityGapMs = undefined;
      this.commissioningEpochId = randomUUID();
      this.commissioningStartedAtMonotonicMs = performance.now() + MonitorService.COMMISSIONING_WARMUP_MS;
      this.commissioningStartedAtWallMs = Date.now() + MonitorService.COMMISSIONING_WARMUP_MS;
      this.commissioningEvidenceFramesDroppedAtStart = this.evidenceFramesDropped;
      this.commissioningFaults.clear();
      this.commissioningLastValidCompletionByTarget.clear();
      this.commissioningValidRevisitsByTarget.clear();
      this.commissioningOnTimeRevisitsByTarget.clear();
      this.storageMaintenance = {
        ...nextConfig.retentionPolicy,
        deletedSessions: this.storageMaintenance.deletedSessions,
        deletedExports: this.storageMaintenance.deletedExports,
        reclaimedBytes: this.storageMaintenance.reclaimedBytes,
        pressure: this.storageMaintenance.pressure,
      };
      this.configureAssignments();
      await this.evidence.initialize(this.sessionMetadata("settings-applied"));
      await this.refreshSessionList();
      this.evidenceHealthy = true;
      if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = setInterval(() => void this.runStorageMaintenance(), nextConfig.retentionPolicy.maintenanceIntervalMs);
      this.maintenanceTimer.unref();
    } catch (error) {
      this.config = previous;
      this.detector = new DetectionEngine(previous.detectionThresholds);
      this.configureAssignments();
      if (!this.evidence.currentSession) await this.evidence.initialize(this.sessionMetadata("settings-rollback")).catch(() => undefined);
      throw error;
    } finally {
      this.reconfiguring = false;
      // Assignment selection deliberately refuses to run while a configuration
      // transaction is open. Start it only after that gate is released so a
      // successful apply (or rollback) cannot leave monitoring idle.
      this.scheduleAllAssignments();
      this.broadcastSnapshot();
    }
    return this.getSnapshot();
  }

  async startFocus(input: { bandId: string; centerHz?: number; durationMs?: number }): Promise<FocusSession> {
    if (this.syntheticExercise) throw new Error("Finish the simulation test before checking one frequency");
    const catalogBand = this.config.bandCatalog.bands.find((band) => band.id === input.bandId);
    if (!catalogBand) throw new Error("Select a frequency from the installed catalog");
    const allowed = validFocusFrequencies(catalogBand);
    const centerHz = input.centerHz ?? catalogBand.centerHz;
    if (!allowed.includes(centerHz)) throw new Error("The selected frequency does not align with this service's documented channel plan");
    const durationMs = input.durationMs ?? this.config.operationalSettings.liveFocusTimeoutMs;
    if (!Number.isInteger(durationMs) || durationMs < 60_000 || durationMs > this.config.operationalSettings.liveFocusTimeoutMs) {
      throw new Error(`Check duration must be between 1 and ${Math.round(this.config.operationalSettings.liveFocusTimeoutMs / 60_000)} minutes`);
    }
    if (this.activeFocus) await this.stopFocus("replaced");
    const receiver = catalogBand.service === "gnss" && this.receiverStates.length >= 2 ? 1 : 0;
    const tuneCenterHz = catalogBand.captureCenterHz ?? centerHz;
    const captureSpanHz = catalogBand.captureSpanHz ?? Math.min(this.config.sampleRateHz, catalogBand.endHz - catalogBand.startHz);
    const halfSpan = Math.min(this.config.sampleRateHz, captureSpanHz) / 2;
    const startHz = Math.round(tuneCenterHz - halfSpan);
    const endHz = Math.round(tuneCenterHz + halfSpan);
    const focusTarget = this.getMonitorTargets()
      .filter((target) => target.relatedBandIds.includes(catalogBand.id))
      .sort((left, right) => Number(right.priority) - Number(left.priority) || Math.abs(left.centerHz - tuneCenterHz) - Math.abs(right.centerHz - tuneCenterHz))[0];
    const assignment = this.assignments.find((candidate) => candidate.receiver === receiver);
    if (assignment?.active) this.completeUnknownVisit(assignment, "configuration-changed");
    if (assignment?.timer) clearTimeout(assignment.timer);
    const startedAt = new Date().toISOString();
    const focusId = randomUUID();
    const targetId = focusTarget?.id ?? monitorTargetId(startHz, endHz);
    const visitEpoch = ++this.visitEpoch;
    const tuneContext = Object.freeze({
      configurationEpoch: this.configurationEpoch,
      visitEpoch,
      visitId: focusId,
      targetId,
    });
    const tuneEpoch = this.clients[receiver]?.tune(catalogBand, tuneCenterHz, tuneContext) ?? ++this.syntheticTuneEpoch;
    this.activeFocusEpoch = Object.freeze({
      ...tuneContext,
      tuneEpoch,
      requestedCenterHz: tuneCenterHz,
      sampleRateHz: this.config.sampleRateHz,
    });
    this.activeFocus = {
      id: focusId,
      bandId: catalogBand.id,
      label: catalogBand.channelSpacingHz ? `${catalogBand.label} at ${(centerHz / 1_000_000).toFixed(3)} MHz` : catalogBand.label,
      service: catalogBand.service,
      receiver,
      centerHz: tuneCenterHz,
      startHz,
      endHz,
      targetId,
      startedAt,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
    };
    const state = this.receiverStates[receiver];
    if (state) {
      state.activeBandId = catalogBand.id;
      state.activeWindowId = `live-focus-${this.activeFocus.id}`;
      state.tunedCenterHz = centerHz;
      state.activeStartHz = startHz;
      state.activeEndHz = endHz;
    }
    if (this.evidenceHealthy) await this.evidence.recordOperationalAction({
      type: "live-focus-started",
      ...this.activeFocus,
      exclusive: true,
      suspendedObjectives: (assignment?.targets ?? []).filter((target) => target.id !== focusTarget?.id).map((target) => ({
        targetId: target.id,
        revisitObjectiveMs: target.revisitObjectiveMs ?? target.dwellMs,
      })),
    }).catch((error) => this.markStorageError(error));
    this.broadcastSnapshot();
    return { ...this.activeFocus };
  }

  async stopFocus(reason = "operator-resumed"): Promise<void> {
    const focus = this.activeFocus;
    if (!focus) return;
    this.activeFocus = undefined;
    this.activeFocusEpoch = undefined;
    const assignment = this.assignments.find((candidate) => candidate.receiver === focus.receiver);
    this.sweepBuilders.clear();
    if (this.evidenceHealthy) await this.evidence.recordOperationalAction({ type: "live-focus-stopped", focusId: focus.id, bandId: focus.bandId, timestamp: new Date().toISOString(), reason }).catch((error) => this.markStorageError(error));
    if (assignment) this.scheduleAssignment(assignment);
    this.broadcastSnapshot();
  }

  async acknowledgeEvent(eventId: string): Promise<DetectionEvent | undefined> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) return undefined;
    event.acknowledgedAt = new Date().toISOString();
    if (this.activeEvent?.id === eventId) this.activeEvent = event;
    if (!event.syntheticExercise && this.evidenceHealthy) await this.persistEvent({ ...event }).catch((error) => this.markStorageError(error));
    this.broadcastSnapshot();
    return event;
  }

  async addNote(eventId: string, text: string): Promise<DetectionEvent | undefined> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) return undefined;
    const note = { id: randomUUID(), timestamp: new Date().toISOString(), text: text.trim() };
    if (!note.text) return event;
    if (event.notes.length >= MAX_EVENT_NOTES) throw new Error(`An incident can contain at most ${MAX_EVENT_NOTES} notes`);
    const projectedNoteBytes = event.notes.reduce((total, item) => total + Buffer.byteLength(item.text), 0) + Buffer.byteLength(note.text);
    if (projectedNoteBytes > MAX_EVENT_NOTE_BYTES) throw new Error("Incident notes have reached the 32 KiB resource bound");
    event.notes = [...event.notes, note];
    const currentSessionId = this.evidence.currentSession?.id;
    const destinationSessionId = currentSessionId && (event.sessionIds ?? [event.sessionId]).includes(currentSessionId)
      ? currentSessionId
      : event.sessionId;
    if (!event.syntheticExercise && this.evidenceHealthy) {
      await this.evidence.addNote(destinationSessionId, eventId, note.text).catch((error) => this.markStorageError(error));
      await this.persistEvent({ ...event }, destinationSessionId).catch((error) => this.markStorageError(error));
    }
    this.broadcastSnapshot();
    return event;
  }

  async exportIncident(eventId: string, sessionId?: string, immutableExportId?: string): Promise<string | string[] | undefined> {
    let event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) event = await this.evidence.findIncidentEvent(eventId, sessionId);
    if (!event || event.syntheticExercise || !this.evidenceHealthy) return undefined;
    if (event.clearedAt) {
      const captureCompleteAt = Date.parse(event.clearedAt) + 10 * 60_000;
      if (Date.now() < captureCompleteAt) {
        throw new Error(`Post-clear evidence is still recording until ${new Date(captureCompleteAt).toISOString()}`);
      }
    }
    try {
      return await this.evidence.exportIncident(event, {
        immutableExportId,
        minimumFreeBytes: this.config.retentionPolicy.minimumFreeBytes,
        baselineReference: this.baselineReferenceFor(event),
      });
    } finally {
      await this.refreshSessionList().catch(() => undefined);
    }
  }

  private async archivedEventsForSession(sessionId: string): Promise<DetectionEvent[]> {
    const persisted = await this.evidence.listSessionEvents(sessionId);
    const latestById = new Map(persisted.map((event) => [event.id, event]));
    for (const event of this.events) {
      if ((event.sessionIds ?? [event.sessionId]).includes(sessionId)) latestById.set(event.id, event);
    }
    return [...latestById.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((event) => ({
        ...event,
        notes: event.notes.slice(-8).map((note) => ({ ...note, text: note.text.slice(0, 512) })),
      }));
  }

  async getEvidenceArchive(offset = 0, limit = 20, eventOffset = 0, eventLimit = 5): Promise<EvidenceArchivePage> {
    const currentSession = this.evidence.currentSession;
    const storedSessions = await this.evidence.listSessions();
    const sessions = [
      ...(currentSession ? [currentSession] : []),
      ...storedSessions.filter((session) => session.id !== currentSession?.id),
    ];
    const sessionPage = boundedPage(offset, limit, 20, 20);
    const eventPage = boundedPage(eventOffset, eventLimit, 5, 5);
    const safeOffset = sessionPage.offset;
    const safeLimit = sessionPage.limit;
    const pageSessions = sessions.slice(safeOffset, safeOffset + safeLimit);
    const archiveSessions = await Promise.all(pageSessions.map(async (session) => {
      const events = await this.archivedEventsForSession(session.id);
      return {
        ...session,
        events: events.slice(eventPage.offset, eventPage.offset + eventPage.limit),
        totalEvents: events.length,
        eventsOffset: eventPage.offset,
        eventsLimit: eventPage.limit,
        hasMoreEvents: eventPage.offset + eventPage.limit < events.length,
      };
    }));
    return {
      generatedAt: new Date().toISOString(),
      offset: safeOffset,
      limit: safeLimit,
      totalSessions: sessions.length,
      sessions: archiveSessions,
    };
  }

  async getEvidenceSessionEvents(sessionId: string, offset = 0, limit = 20): Promise<EvidenceArchiveEventPage | undefined> {
    const currentSession = this.evidence.currentSession;
    const storedSessions = await this.evidence.listSessions();
    if (currentSession?.id !== sessionId && !storedSessions.some((session) => session.id === sessionId)) return undefined;
    const page = boundedPage(offset, limit, 25, 20);
    const events = await this.archivedEventsForSession(sessionId);
    return {
      generatedAt: new Date().toISOString(),
      sessionId,
      offset: page.offset,
      limit: page.limit,
      totalEvents: events.length,
      events: events.slice(page.offset, page.offset + page.limit),
    };
  }

  async exportSession(sessionId: string, immutableExportId?: string): Promise<string | string[] | undefined> {
    if (!this.evidenceHealthy) return undefined;
    const currentSession = this.evidence.currentSession;
    const storedSessions = await this.evidence.listSessions();
    if (currentSession?.id !== sessionId && !storedSessions.some((session) => session.id === sessionId)) return undefined;
    try {
      return await this.evidence.exportSession(sessionId, immutableExportId, this.config.retentionPolicy.minimumFreeBytes);
    } finally {
      await this.refreshSessionList().catch(() => undefined);
    }
  }

  async prepareSessionExport(sessionId: string) {
    if (!this.evidenceHealthy) return undefined;
    return this.evidence.prepareSessionExport(sessionId);
  }

  protectExportArtifacts(paths: readonly string[], protect: boolean): void {
    this.evidence.protectExportArtifacts(paths, protect);
  }

  async discardExportArtifacts(paths: readonly string[]): Promise<void> {
    await this.evidence.discardExportArtifacts(paths);
  }

  reserveScreenshot(eventId: string, expectedBytes: number) {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event || event.syntheticExercise) {
      return { admitted: false as const, reason: "not-found" as const, retryAfterSeconds: 0 };
    }
    const writer = this.evidence.getWriterHealth();
    if (!this.evidenceHealthy || this.storageMaintenance.pressure || this.resourceHealthState !== "normal"
      || writer.queueItems >= 64 || writer.queueBytes + expectedBytes + 4 * 1024 > 2 * 1024 * 1024) {
      return { admitted: false as const, reason: "pressure" as const, retryAfterSeconds: 10 };
    }
    const admission = this.evidence.reserveScreenshot(eventId, expectedBytes);
    return admission ?? { admitted: false as const, reason: "pressure" as const, retryAfterSeconds: 10 };
  }

  async addScreenshot(eventId: string, png: Buffer, admittedLease?: ScreenshotAdmissionLease): Promise<boolean> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event || event.syntheticExercise || !this.evidenceHealthy) {
      admittedLease?.release();
      return false;
    }
    validateScreenshotPng(png);
    const admission = admittedLease
      ? { admitted: true as const, lease: admittedLease }
      : this.reserveScreenshot(eventId, png.byteLength);
    if (!admission.admitted) return false;
    if (admission.lease.eventId !== eventId || png.byteLength > admission.lease.reservedBytes) {
      admission.lease.release();
      throw new Error("Screenshot body does not match its admission lease");
    }
    const currentSessionId = this.evidence.currentSession?.id;
    const destinationSessionId = currentSessionId && (event.sessionIds ?? [event.sessionId]).includes(currentSessionId)
      ? currentSessionId
      : event.sessionId;
    try {
      await this.evidence.recordScreenshot(destinationSessionId, eventId, png, admission.lease);
      this.broadcastSnapshot();
      return true;
    } catch (error) {
      admission.lease.release();
      throw error;
    }
  }

  async runStorageMaintenance(): Promise<StorageMaintenanceStatus> {
    if (this.reconfiguring) return this.storageMaintenance;
    if (this.maintenanceRunning) return this.storageMaintenance;
    this.maintenanceRunning = true;
    try {
      this.expireIncident();
      if (this.evidence.shouldRotate(
        this.config.retentionPolicy.sessionMaxBytes,
        this.config.retentionPolicy.sessionMaxMs,
      )) {
        const continuingById = new Map([...this.activeEventsByTarget.values()].map((event) => [event.id, event]));
        for (const [targetId, until] of this.postClearUntilByTarget) {
          if (until <= Date.now()) continue;
          const tailEvent = this.events.find((event) => event.targetId === targetId && event.clearedAt);
          if (tailEvent) continuingById.set(tailEvent.id, tailEvent);
        }
        const continuingEvents = [...continuingById.values()];
        await this.checkpointSessionContext("session-rotation-closing");
        const nextSession = await this.evidence.rotate(this.sessionMetadata("session-rotation"));
        if (continuingEvents.length) {
          for (const event of continuingEvents) {
            event.sessionIds = [...new Set([event.sessionId, ...(event.sessionIds ?? []), nextSession.id])];
            await this.persistEvent({ ...event }, nextSession.id);
          }
          await this.evidence.recordOperationalAction({
            type: "incident-continuation",
            incidents: continuingEvents.map((event) => ({ eventId: event.id, sessionIds: event.sessionIds })),
          });
        }
      }
      const protectedSessionIds = new Set(this.events
        .filter((event) => !event.clearedAt || Date.now() < Date.parse(event.clearedAt) + 10 * 60_000)
        .flatMap((event) => [event.sessionId, ...(event.sessionIds ?? [])]));
      const report = await this.evidence.maintain(this.config.retentionPolicy, Date.now(), protectedSessionIds);
      this.storageMaintenance = report;
      if (report.deletedSessionIds.length) {
        const deleted = new Set(report.deletedSessionIds);
        this.events = this.events.filter((event) => (event.sessionIds ?? [event.sessionId]).some((sessionId) => !deleted.has(sessionId)));
      }
      await this.refreshSessionList();
      this.evidenceHealthy = !report.pressure && Boolean(this.evidence.currentSession);
      if (report.pressure) {
        this.emitServiceError("Evidence recording paused: storage limits remain exceeded after retention cleanup.");
      }
      this.broadcastSnapshot();
      return this.storageMaintenance;
    } catch (error) {
      this.evidenceHealthy = false;
      this.emitServiceError(`Evidence maintenance failed: ${String(error)}`);
      this.broadcastSnapshot();
      return this.storageMaintenance;
    } finally {
      this.maintenanceRunning = false;
      for (const resolve of this.maintenanceIdleWaiters.splice(0)) resolve();
    }
  }

  private async waitForStorageMaintenance(): Promise<void> {
    if (!this.maintenanceRunning) return;
    await new Promise<void>((resolve) => this.maintenanceIdleWaiters.push(resolve));
  }

  private async connectReceivers(): Promise<void> {
    const attempts = this.config.receiverUrls.map(async (url, id) => {
      const client = new SdrconnectClient({
        id,
        url,
        timeoutMs: this.config.sdrConnectTimeoutMs,
        sampleRateHz: this.config.sampleRateHz,
        deviceIndex: this.config.sdrDeviceIndex,
        tlsRejectUnauthorized: this.config.tlsRejectUnauthorized,
        maxSpectrumRateHz: this.config.maxSpectrumRateHz,
      });
      this.clients.push(client);
      this.receiverMetrics.set(id, { overload: false });
      client.on("state", (state: ConnectionState) => {
        const receiver = this.receiverStates[id];
        receiver.connection = state;
        receiver.socketConnected = !["connecting", "offline"].includes(state);
        receiver.apiReady = ["api-ready", "live", "stale"].includes(state);
        receiver.transportState = state === "offline" ? "offline" : state === "connecting" ? "reconnecting" : "connected";
        if (state === "offline") { receiver.streamReady = false; receiver.streamState = "stopped"; receiver.tuneState = "idle"; }
        if (state === "stale") receiver.streamState = "stalled";
        if (state === "live") { receiver.streamState = "live"; receiver.recoveryState = "idle"; receiver.reconnectAttempts = 0; }
        if (state === "live" && this.simulator) this.stopSimulation();
        this.scheduleSessionContextCheckpoint();
        this.broadcastSnapshot();
      });
      client.on("spectrum", (payload: SdrconnectSpectrumPayload) => this.handleSpectrum(id, payload.bins, "sdrconnect", payload));
      client.on("tune-state", (state) => { this.receiverStates[id].tuneState = state; this.broadcastSnapshot(); });
      client.on("tune-confirmed", (confirmation: {
        configurationEpoch: number;
        tuneEpoch: number;
        visitEpoch: number;
        visitId: string;
        targetId: string;
        centerHz: number;
        sampleRateHz: number;
        confirmedAt: string;
      }) => {
        const expected = this.expectedRfEpoch(id);
        if (
          !expected
          || confirmation.configurationEpoch !== expected.configurationEpoch
          || confirmation.tuneEpoch !== expected.tuneEpoch
          || confirmation.visitEpoch !== expected.visitEpoch
          || confirmation.visitId !== expected.visitId
          || confirmation.targetId !== expected.targetId
          || confirmation.centerHz !== expected.requestedCenterHz
          || confirmation.sampleRateHz !== expected.sampleRateHz
        ) return;
        this.receiverStates[id].tuneConfirmedAt = confirmation.confirmedAt;
        this.receiverStates[id].confirmedCenterHz = confirmation.centerHz;
        this.receiverStates[id].confirmedSampleRateHz = confirmation.sampleRateHz;
      });
      client.on("tune-failed", (failure: { tuneEpoch: number; reason: "tune-timeout" | "tune-mismatch" }) => this.failVisit(id, failure.tuneEpoch, failure.reason));
      client.on("stream-stalled", () => {
        const receiver = this.receiverStates[id];
        receiver.streamReady = false;
        receiver.streamState = "stalled";
        receiver.recoveryState = receiver.hardwareState === "absent" ? "waiting-for-hardware" : "recovering";
        this.broadcastSnapshot();
      });
      client.on("hardware", (state: "present" | "absent") => {
        const receiver = this.receiverStates[id];
        receiver.hardwareState = state;
        if (state === "absent") {
          receiver.deviceReady = false;
          receiver.streamReady = false;
          receiver.streamState = "stopped";
          receiver.recoveryState = "waiting-for-hardware";
        }
        this.broadcastSnapshot();
      });
      client.on("reconnect-attempt", (attempts: number) => {
        this.receiverStates[id].reconnectAttempts = attempts;
      });
      client.on("property", (message: SdrconnectPropertyMessage) => this.handleProperty(id, message));
      client.on("client-error", (error: Error) => { this.receiverStates[id].lastError = error.message; this.emitServiceError(error.message); });
      try {
        await client.connect();
      } catch {
        this.receiverStates[id].connection = "offline";
      }
    });
    await Promise.all(attempts);
  }

  private configureAssignments(): void {
    for (const assignment of this.assignments) if (assignment.timer) clearTimeout(assignment.timer);
    this.assignments.length = 0;
    const receiverCount = Math.max(1, this.receiverStates.length);
    const targetsFor = (bands: BandPreset[]) => compileScanTargets(bands, this.config.sampleRateHz);
    if (receiverCount === 1) {
      this.assignments.push(this.createAssignment(0, targetsFor(this.config.bands)));
      this.pruneTimingHistory();
      return;
    }
    const radioBands = this.config.bands.filter((band) => band.service !== "gnss");
    const gnssBands = this.config.bands.filter((band) => band.service === "gnss");
    this.assignments.push(this.createAssignment(0, targetsFor(radioBands)));
    this.assignments.push(this.createAssignment(1, targetsFor(gnssBands)));
    for (let receiver = 2; receiver < receiverCount; receiver += 1) {
      const targets = targetsFor(this.config.bands);
      this.assignments.push(this.createAssignment(receiver, targets));
    }
    this.pruneTimingHistory();
  }

  private resetDomainRuntimeState(): void {
    this.activeEvent = undefined;
    this.activeEventsByTarget.clear();
    this.events = [];
    this.currentFrame = undefined;
    this.currentMetrics = undefined;
    this.waterfall = [];
    this.waterfallByTarget.clear();
    this.frameByTarget.clear();
    this.metricsByTarget.clear();
    this.targetStates.clear();
    this.sweepBuilders.clear();
    this.completedSweeps.clear();
    this.frameCounters.clear();
    this.spectrumRingByReceiver.clear();
    this.prehistoryCandidateTargets.clear();
    this.prehistoryFrozenReceivers.clear();
    this.postClearUntilByTarget.clear();
    this.lastEvidenceFrameAtByTarget.clear();
    this.lastBaselineTrainingAtByTarget.clear();
    this.activeBaselineFingerprints.clear();
    this.activeBaselineFingerprintIdByTarget.clear();
    this.timingHistoryByTarget.clear();
    this.timingCauseTotalsByTarget.clear();
    this.timingHistogramsByTarget.clear();
    this.acceptedAttributionInvariantViolations = 0;
    this.measuredPriorityGapMs = undefined;
    this.spectrumFramesAnalyzed = 0;
    this.evidenceFramesRecorded = 0;
    this.evidenceFramesDropped = 0;
    this.evidenceWritesInFlight = 0;
    this.evidenceWriteBytesInFlight = 0;
    this.evidenceWriteStartedAt.splice(0);
    this.evidenceWriteSamples.splice(0);
    this.commissioningEvidenceFramesDroppedAtStart = 0;
    this.commissioningFaults.clear();
    this.commissioningLastValidCompletionByTarget.clear();
    this.commissioningValidRevisitsByTarget.clear();
    this.commissioningOnTimeRevisitsByTarget.clear();
    this.commissioningEpochId = randomUUID();
    this.commissioningStartedAtMonotonicMs = performance.now() + MonitorService.COMMISSIONING_WARMUP_MS;
    this.commissioningStartedAtWallMs = Date.now() + MonitorService.COMMISSIONING_WARMUP_MS;
    this.configurationEpoch += 1;
  }

  private recordTimingCompletion(completion: VisitRecord): void {
    const history = this.timingHistoryByTarget.get(completion.targetId) ?? [];
    history.push(completion);
    if (history.length > 1_024) history.splice(0, history.length - 1_024);
    this.timingHistoryByTarget.set(completion.targetId, history);
    const knownCauses = new Set([
      "tune-timeout",
      "insufficient-frames",
      "receiver-unhealthy",
      "configuration-changed",
      "tune-mismatch",
      "bin-grid-changed",
      "revisit-objective-missed",
      "invalid-observation",
    ]);
    const boundedCause = (value: string | undefined): string => value && knownCauses.has(value) ? value : "other";
    const causes = this.timingCauseTotalsByTarget.get(completion.targetId) ?? { misses: {}, unknowns: {} };
    if (!completion.valid) {
      const cause = boundedCause(completion.completionCause);
      causes.unknowns[cause] = (causes.unknowns[cause] ?? 0) + 1;
    }
    if (completion.missedObjective) {
      const cause = boundedCause(completion.missCause ?? completion.completionCause);
      causes.misses[cause] = (causes.misses[cause] ?? 0) + 1;
    }
    this.timingCauseTotalsByTarget.set(completion.targetId, causes);
    const histograms = this.timingHistogramsByTarget.get(completion.targetId) ?? {
      revisitCounts: COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS.map(() => 0),
      revisitOverflow: 0,
      revisitSamples: 0,
      gapCounts: COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS.map(() => 0),
      gapOverflow: 0,
      gapSamples: 0,
    };
    const increment = (value: number | undefined, counts: number[], overflow: "revisitOverflow" | "gapOverflow", samples: "revisitSamples" | "gapSamples"): void => {
      if (value === undefined) return;
      const index = COMMISSIONING_TIMING_HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound);
      if (index < 0) histograms[overflow] += 1;
      else counts[index] += 1;
      histograms[samples] += 1;
    };
    increment(completion.revisitMs, histograms.revisitCounts, "revisitOverflow", "revisitSamples");
    increment(completion.actualUnobservedGapMs, histograms.gapCounts, "gapOverflow", "gapSamples");
    this.timingHistogramsByTarget.set(completion.targetId, histograms);
    this.recordCommissioningTimingCompletion(completion);
  }

  private recordCommissioningTimingCompletion(completion: VisitRecord): void {
    if (completion.completedAtMs < this.commissioningStartedAtMonotonicMs) return;
    if (!completion.valid) {
      // A bounded attempt may begin during preparation and finish immediately
      // after the boundary. Exclude that whole startup visit; continuous
      // coverage is still enforced by the first-valid deadline below.
      if (completion.startedAtMs < this.commissioningStartedAtMonotonicMs) return;
      this.commissioningFaults.add(`unknown-visit:${completion.completionCause}`);
      return;
    }

    const previousInEpoch = this.commissioningLastValidCompletionByTarget.get(completion.targetId);
    this.commissioningLastValidCompletionByTarget.set(completion.targetId, completion.completedAtMs);
    // The first valid completion after warm-up is an epoch anchor. A revisit
    // that began during preparation is not scored as part of qualification.
    if (previousInEpoch === undefined) {
      return;
    }

    this.commissioningValidRevisitsByTarget.set(
      completion.targetId,
      (this.commissioningValidRevisitsByTarget.get(completion.targetId) ?? 0) + 1,
    );
    if (completion.completedAtMs - previousInEpoch <= completion.revisitObjectiveMs) {
      this.commissioningOnTimeRevisitsByTarget.set(
        completion.targetId,
        (this.commissioningOnTimeRevisitsByTarget.get(completion.targetId) ?? 0) + 1,
      );
    }
  }

  private pruneTimingHistory(): void {
    const activeTargetIds = new Set(this.assignments.flatMap((assignment) => assignment.targets.map((target) => target.id)));
    for (const targetId of this.timingHistoryByTarget.keys()) if (!activeTargetIds.has(targetId)) this.timingHistoryByTarget.delete(targetId);
    for (const targetId of this.timingCauseTotalsByTarget.keys()) if (!activeTargetIds.has(targetId)) this.timingCauseTotalsByTarget.delete(targetId);
    for (const targetId of this.timingHistogramsByTarget.keys()) if (!activeTargetIds.has(targetId)) this.timingHistogramsByTarget.delete(targetId);
  }

  private createAssignment(receiver: number, targets: CompiledScanTarget[]): BandAssignment {
    const now = performance.now();
    const profile = this.config.operationalSettings.scan.profile;
    const deadlineTargets = targets.map((target) => {
      const firstBand = target.coverage[0].band;
      const capture = firstBand.captureTargetId
        ? this.config.bandCatalog.captureTargets.find((candidate) => candidate.id === firstBand.captureTargetId)
        : undefined;
      const tier = capture
        ? captureTargetTierForProfile(capture, this.config.operationalSettings, this.config.bandCatalog)
        : "survey" as const;
      return {
        id: target.id,
        tier,
        revisitObjectiveMs: profile === "gnss-priority" && tier === "tier1"
          ? this.config.operationalSettings.scan.maxPriorityGapMs
          : target.revisitObjectiveMs ?? Math.max(target.dwellMs, targets.reduce((sum, item) => sum + item.dwellMs, 0)),
        nominalVisitMs: target.nominalVisitMs ?? target.dwellMs,
        maxVisitMs: target.maxVisitMs ?? target.dwellMs,
        // Service priority remains operator-configurable; the catalog weight is
        // a within-service recommendation. EDF Tier-1 ordering still depends on
        // deadlines, while optional weighted-deficit scheduling uses both.
        weight: Math.max(1, firstBand.priority) * Math.max(1, capture?.weight ?? 1),
      };
    });
    const phased = profile === "fast-gnss" ? {
      "gnss-l1-e1-b1c-sbas": now,
      "gnss-gps-l2c": now - 4_000,
      "gnss-l5-e5a-b2a": now - 2_000,
      "gnss-glonass-g1": now,
    } : undefined;
    return {
      receiver,
      targets,
      scheduler: new DeadlineScheduler(deadlineTargets, {
        initialNowMs: now,
        // These anchors only establish the documented first-cycle phase. They
        // are not observations: the first real completion must not be scored as
        // a revisit against an invented startup sample.
        initialPhaseAnchorsMs: phased,
        // The 24-hour qualification gate belongs only to the new fast profile.
        // Existing balanced/priority selections must retain their prior survey
        // behavior after migration and after every service restart.
        optionalQualificationMs: profile === "fast-gnss" ? 24 * 60 * 60_000 : 0,
        minimumTierOneValidRevisitsForOptional: profile === "fast-gnss" ? 1 : 0,
        enforceOptionalQualification: profile === "fast-gnss",
      }),
    };
  }

  private scheduleAllAssignments(): void {
    for (const assignment of this.assignments) this.startNextVisit(assignment);
  }

  private scheduleAssignment(assignment: BandAssignment, delayMs = 0): void {
    if (assignment.timer) clearTimeout(assignment.timer);
    assignment.timer = setTimeout(() => {
      assignment.timer = undefined;
      if (assignment.active) this.visitBudgetExpired(assignment);
      else this.startNextVisit(assignment);
    }, Math.max(0, delayMs));
    assignment.timer.unref();
  }

  private startNextVisit(assignment: BandAssignment): void {
    if (this.paused || this.reconfiguring || this.activeFocus?.receiver === assignment.receiver || assignment.active || !assignment.targets.length) return;
    const receiver = this.receiverStates[assignment.receiver];
    if (receiver?.hardwareState === "absent") {
      this.scheduleAssignment(assignment, 1_000);
      return;
    }
    const selectedAtMonotonic = performance.now();
    const decision = assignment.scheduler.beginNext(selectedAtMonotonic);
    if (!decision) {
      const nextSelectionAtMs = assignment.scheduler.nextSelectionAtMs(selectedAtMonotonic);
      if (nextSelectionAtMs !== undefined) {
        this.scheduleAssignment(assignment, Math.max(1, nextSelectionAtMs - selectedAtMonotonic));
      }
      return;
    }
    const target = assignment.targets.find((candidate) => candidate.id === decision.target.id);
    if (!target) {
      assignment.scheduler.completeActive({ valid: false, completedAtMs: performance.now(), cause: "unknown-target" });
      this.scheduleAssignment(assignment);
      return;
    }
    const band = target.coverage[0].band;
    const visitId = randomUUID();
    const visitEpoch = ++this.visitEpoch;
    const tuneContext = Object.freeze({
      configurationEpoch: this.configurationEpoch,
      visitEpoch,
      visitId,
      targetId: target.id,
    });
    const tuneEpoch = this.clients[assignment.receiver]?.tune(band, target.centerHz, tuneContext) ?? ++this.syntheticTuneEpoch;
    const epoch = Object.freeze({
      ...tuneContext,
      tuneEpoch,
      requestedCenterHz: target.centerHz,
      sampleRateHz: this.config.sampleRateHz,
    });
    const selectedAt = new Date().toISOString();
    const visit: TargetVisit = {
      id: visitId,
      targetId: target.id,
      affectedBandIds: [...new Set(target.coverage.map((item) => item.band.id))],
      receiver: assignment.receiver,
      configurationEpoch: this.configurationEpoch,
      tuneEpoch,
      visitEpoch,
      selectedAt,
      commandAt: selectedAt,
      discardedFrames: target.discardFrames ?? 2,
      acceptedFrames: 0,
      requestedCenterHz: target.centerHz,
    };
    assignment.active = { visit, epoch, target, frames: [], extended: false, startedMonotonicMs: selectedAtMonotonic };
    if (receiver) Object.assign(receiver, {
      activeBandId: band.id,
      activeWindowId: target.id,
      tunedCenterHz: target.centerHz,
      activeStartHz: target.startHz,
      activeEndHz: target.endHz,
      tuneState: "commanded" as const,
      tuneConfirmedAt: undefined,
    });
    this.scheduleAssignment(assignment, decision.target.nominalVisitMs);
  }

  private visitBudgetExpired(assignment: BandAssignment): void {
    const active = assignment.active;
    if (!active) return;
    if (this.syntheticExercise?.ownsVisit(active.target.id, active.visit.id)) {
      this.completeSyntheticUnknownVisit(assignment, "insufficient-frames");
      return;
    }
    const nominal = active.target.nominalVisitMs ?? active.target.dwellMs;
    const maximum = active.target.maxVisitMs ?? active.target.dwellMs;
    if (maximum > nominal && !active.extended && assignment.scheduler.canExtendActive(maximum, performance.now()).allowed) {
      active.extended = true;
      const elapsed = Math.max(0, performance.now() - active.startedMonotonicMs);
      this.scheduleAssignment(assignment, Math.max(1, maximum - elapsed));
      return;
    }
    this.completeUnknownVisit(assignment, "insufficient-frames");
  }

  private failVisit(receiverId: number, tuneEpoch: number, reason: "tune-timeout" | "tune-mismatch"): void {
    const assignment = this.assignments.find((candidate) => candidate.receiver === receiverId);
    if (!assignment?.active || assignment.active.visit.tuneEpoch !== tuneEpoch) return;
    this.completeUnknownVisit(assignment, reason);
  }

  private completeSyntheticVisit(assignment: BandAssignment, active: VisitAccumulator, timestamp: string): void {
    if (assignment.timer) clearTimeout(assignment.timer);
    active.visit.completedAt = timestamp;
    active.visit.outcome = "valid";
    const completedAtMonotonicMs = performance.now();
    const firstObservedAtMs = active.frames[0]?.receivedMonotonicMs;
    const lastObservedAtMs = active.frames.at(-1)?.receivedMonotonicMs;
    const completion = assignment.scheduler.completeActive({
      valid: true,
      completedAtMs: completedAtMonotonicMs,
      observedExposureMs: firstObservedAtMs !== undefined && lastObservedAtMs !== undefined
        ? Math.max(0, lastObservedAtMs - firstObservedAtMs)
        : 0,
      ...(firstObservedAtMs !== undefined && lastObservedAtMs !== undefined ? { firstObservedAtMs, lastObservedAtMs } : {}),
    });
    Object.assign(active.visit, {
      observedExposureMs: completion.observedExposureMs,
      revisitMs: completion.revisitMs,
      actualUnobservedGapMs: completion.actualUnobservedGapMs,
      visitDurationMs: completion.durationMs,
      missedObjective: completion.missedObjective,
      missByMs: completion.missByMs,
    });
    const marker = this.syntheticExercise?.marker;
    if (marker && this.evidenceHealthy) {
      void this.evidence.recordOperationalAction({
        type: "synthetic-target-visit-completed",
        dataDomain: this.config.dataDomain,
        visit: active.visit,
        syntheticExercise: marker,
      }).catch((error) => this.markStorageError(error));
    }
    assignment.active = undefined;
    this.scheduleAssignment(assignment);
    this.broadcastSnapshot();
  }

  private completeSyntheticUnknownVisit(
    assignment: BandAssignment,
    reason: "tune-timeout" | "insufficient-frames" | "receiver-unhealthy" | "configuration-changed" | "tune-mismatch" | "bin-grid-changed",
  ): void {
    const active = assignment.active;
    if (!active) return;
    if (assignment.timer) clearTimeout(assignment.timer);
    const timestamp = new Date().toISOString();
    active.visit.failedAt = timestamp;
    active.visit.outcome = "unknown";
    active.visit.failureReason = reason;
    const firstObservedAtMs = active.frames[0]?.receivedMonotonicMs;
    const lastObservedAtMs = active.frames.at(-1)?.receivedMonotonicMs;
    assignment.scheduler.completeActive({
      valid: false,
      completedAtMs: performance.now(),
      cause: `synthetic-${reason}`,
      observedExposureMs: firstObservedAtMs !== undefined && lastObservedAtMs !== undefined
        ? Math.max(0, lastObservedAtMs - firstObservedAtMs)
        : 0,
      ...(firstObservedAtMs !== undefined && lastObservedAtMs !== undefined ? { firstObservedAtMs, lastObservedAtMs } : {}),
    });
    const marker = this.syntheticExercise?.marker;
    if (marker && this.evidenceHealthy) {
      void this.evidence.recordOperationalAction({
        type: "synthetic-target-visit-unknown",
        dataDomain: this.config.dataDomain,
        visit: active.visit,
        syntheticExercise: marker,
      }).catch((error) => this.markStorageError(error));
    }
    assignment.active = undefined;
    this.syntheticExercise?.noteUnknown();
    const previous = this.targetStates.get(active.visit.targetId) ?? this.clearTargetState(active.visit.targetId);
    const next = previous.lifecycle === "active" || previous.lifecycle === "recovering"
      ? { ...previous, observationDisposition: "unknown" as const, unknownReason: reason, lastObservedAt: timestamp }
      : {
          ...previous,
          lifecycle: "detecting" as const,
          candidateCount: 0,
          observationDisposition: "unknown" as const,
          unknownReason: reason,
          lastObservedAt: timestamp,
        };
    this.targetStates.set(active.visit.targetId, next);
    this.syntheticExercise?.observeTargetState(next);
    this.scheduleAssignment(assignment);
    this.broadcastSnapshot();
  }

  private completeUnknownVisit(assignment: BandAssignment, reason: "tune-timeout" | "insufficient-frames" | "receiver-unhealthy" | "configuration-changed" | "tune-mismatch" | "bin-grid-changed"): void {
    const active = assignment.active;
    if (!active) return;
    if (assignment.timer) clearTimeout(assignment.timer);
    const timestamp = new Date().toISOString();
    active.visit.failedAt = timestamp;
    active.visit.outcome = "unknown";
    active.visit.failureReason = reason;
    const firstObservedAtMs = active.frames[0]?.receivedMonotonicMs;
    const lastObservedAtMs = active.frames.at(-1)?.receivedMonotonicMs;
    const completion = assignment.scheduler.completeActive({
      valid: false,
      completedAtMs: performance.now(),
      cause: reason,
      observedExposureMs: firstObservedAtMs !== undefined && lastObservedAtMs !== undefined
        ? Math.max(0, lastObservedAtMs - firstObservedAtMs)
        : 0,
      ...(firstObservedAtMs !== undefined && lastObservedAtMs !== undefined ? { firstObservedAtMs, lastObservedAtMs } : {}),
    });
    this.recordTimingCompletion(completion);
    Object.assign(active.visit, {
      visitDurationMs: completion.durationMs,
      revisitMs: completion.revisitMs,
      actualUnobservedGapMs: completion.actualUnobservedGapMs,
      observedExposureMs: completion.observedExposureMs,
      missedObjective: completion.missedObjective,
      missByMs: completion.missByMs,
    });
    assignment.active = undefined;
    const previous = this.targetStates.get(active.visit.targetId) ?? this.clearTargetState(active.visit.targetId);
    this.targetStates.set(active.visit.targetId, { ...previous, observationDisposition: "unknown", unknownReason: reason });
    const inputBinCount = active.frames[0]?.inputBinCount ?? 0;
    const captureSpanHz = Math.max(1, active.target.endHz - active.target.startHz);
    const analysisSpanHz = Math.min(active.target.analysisSpanHz ?? captureSpanHz, captureSpanHz, 8_000_000);
    const analysisBounds = centralAnalysisBinBounds(inputBinCount, analysisSpanHz, captureSpanHz);
    const fingerprint = this.baselineFingerprintFor(
      assignment.receiver,
      active.target,
      inputBinCount,
      analysisBounds.startBin,
      analysisBounds.endBin,
    );
    const activeFingerprintId = this.activeBaselineFingerprintIdByTarget.get(active.visit.targetId);
    const storedFingerprint = fingerprint as unknown as StoredBaselineFingerprint | undefined
      ?? (activeFingerprintId
        ? this.activeBaselineFingerprints.get(`${active.visit.targetId}:${activeFingerprintId}`)
        : undefined);
    if (storedFingerprint && this.baselineStore) {
      try {
        const fingerprintId = BaselineStore.fingerprintId(storedFingerprint);
        this.selectActiveBaselineFingerprint(active.visit.targetId, fingerprintId, storedFingerprint);
        this.baselineStore.ensure(storedFingerprint);
        this.baselineStore.recordGap(storedFingerprint, { observedAt: timestamp, reason });
      } catch (error) {
        this.baselineHealthy = false;
        this.emitServiceError(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.evidenceHealthy) void this.evidence.recordOperationalAction({ type: "target-visit-unknown", visit: active.visit }).catch((error) => this.markStorageError(error));
    this.broadcastSnapshot();
    this.scheduleAssignment(assignment);
  }

  private expectedRfEpoch(receiverId: number): Readonly<ExpectedSdrconnectFrameEpoch> | undefined {
    if (this.activeFocus?.receiver === receiverId) return this.activeFocusEpoch;
    return this.assignments.find((candidate) => candidate.receiver === receiverId)?.active?.epoch;
  }

  private handleSpectrum(
    receiverId: number,
    bins: Uint8Array,
    source: SpectrumFrame["source"],
    transport?: SdrconnectSpectrumPayload,
    synthetic?: SyntheticFrameContext,
  ): void {
    if (this.paused || this.reconfiguring) return;
    if ((source === "simulation" || synthetic) && this.config.dataDomain !== "test") {
      this.emitServiceError("Simulation input was rejected at the field data-domain boundary");
      return;
    }
    const receiver = this.receiverStates[receiverId];
    const assignment = this.assignments.find((candidate) => candidate.receiver === receiverId);
    const focusBand = this.activeFocus?.receiver === receiverId
      ? this.config.bandCatalog.bands.find((candidate) => candidate.id === this.activeFocus?.bandId)
      : undefined;
    const active = assignment?.active;
    const target = active?.target;
    const expectedEpoch = this.expectedRfEpoch(receiverId);
    const coverage = focusBand ? [{ band: focusBand }] : target?.coverage ?? [];
    if (!coverage.length) return;
    if (!focusBand && (!assignment || !active)) return;
    if (!expectedEpoch || expectedEpoch.configurationEpoch !== this.configurationEpoch) {
      this.rejectedRfEpochFrames += 1;
      return;
    }
    if (source === "sdrconnect") {
      if (!transport || !validateSdrconnectFrameEpoch(expectedEpoch, transport).accepted) {
        this.rejectedRfEpochFrames += 1;
        if (performance.now() >= this.commissioningStartedAtMonotonicMs) this.commissioningFaults.add("rf-epoch-frame-rejected");
        return;
      }
    }
    const timestamp = new Date().toISOString();
    const receiverMetric = this.receiverMetrics.get(receiverId) ?? { overload: false };
    const effectiveReceiverMetric = synthetic
      ? { ...receiverMetric, overload: synthetic.sensorState.overload }
      : receiverMetric;
    this.lastUpdatedAt = timestamp;
    if (receiver) {
      receiver.lastFrameAt = timestamp;
      receiver.streamReady = true;
      receiver.hardwareState = "present";
      receiver.streamState = "live";
      receiver.transportState = "connected";
      receiver.recoveryState = "idle";
      receiver.tuneState = "confirmed";
      receiver.tuneConfirmedAt = transport?.tuneConfirmedAt ?? receiver.tuneConfirmedAt ?? timestamp;
      receiver.lastError = undefined;
    }
    const startHz = focusBand ? this.activeFocus!.startHz : target!.startHz;
    const endHz = focusBand ? this.activeFocus!.endHz : target!.endHz;
    const targetId = this.activeFocus?.receiver === receiverId
      ? this.activeFocus.targetId ?? monitorTargetId(startHz, endHz)
      : target!.id;
    if (source === "sdrconnect" && transport && targetId !== expectedEpoch.targetId) {
      this.acceptedAttributionInvariantViolations += 1;
      if (performance.now() >= this.commissioningStartedAtMonotonicMs) this.commissioningFaults.add("accepted-attribution-invariant-violation");
      return;
    }
    if (this.baselineRestartTargets.has(targetId)) return;
    const band = coverage[0].band;
    const captureSpanHz = focusBand ? Math.max(1, endHz - startHz) : target!.endHz - target!.startHz;
    const analysisSpanHz = Math.min(target?.analysisSpanHz ?? captureSpanHz, captureSpanHz, 8_000_000);
    const { startBin: analysisStartBin, endBin: analysisEndBin } = centralAnalysisBinBounds(
      bins.length,
      analysisSpanHz,
      captureSpanHz,
    );
    const storedBins = reduceSpectrumBins(bins, this.config.maxSpectrumBins);
    const displayAnalysisStart = Math.floor((analysisStartBin / Math.max(1, bins.length)) * storedBins.length);
    const displayAnalysisEnd = Math.ceil((analysisEndBin / Math.max(1, bins.length)) * storedBins.length);
    const frame: PersistedSpectrumFrame = {
      id: randomUUID(),
      timestamp,
      receiver: receiverId,
      bandId: band.id,
      targetId,
      scanWindowId: receiver?.activeWindowId ?? band.id,
      startHz,
      endHz,
      bins: storedBins,
      inputBinCount: bins.length,
      binning: bins.length > storedBins.length ? "peak-preserving" : "native",
      source,
      dataDomain: this.config.dataDomain,
      calibrated: false,
      configurationEpoch: expectedEpoch.configurationEpoch,
      tuneEpoch: expectedEpoch.tuneEpoch,
      visitEpoch: expectedEpoch.visitEpoch,
      visitId: expectedEpoch.visitId,
      receivedMonotonicMs: transport?.receivedMonotonicMs ?? performance.now(),
      requestedCenterHz: expectedEpoch.requestedCenterHz,
      confirmedCenterHz: transport?.confirmedCenterHz ?? expectedEpoch.requestedCenterHz,
      confirmedSampleRateHz: transport?.confirmedSampleRateHz ?? expectedEpoch.sampleRateHz,
      analysisStartBin: displayAnalysisStart,
      analysisEndBin: displayAnalysisEnd,
      analysisSpanHz,
      captureSpanHz,
      tuneConfirmedAt: transport?.tuneConfirmedAt ?? timestamp,
      syntheticExercise: synthetic?.marker,
    };
    if (!synthetic) this.pushSpectrumRing(frame);
    const basicMetrics = synthetic
      ? this.relativeMetrics(frame, effectiveReceiverMetric)
      : this.metricsByTarget.get(targetId) ?? this.relativeMetrics(frame, effectiveReceiverMetric);
    if (focusBand) {
      const focusState = this.targetStates.get(targetId) ?? { ...this.clearTargetState(targetId), observationDisposition: "unknown" as const };
      this.publishFrame(frame, basicMetrics, focusState);
      return;
    }

    const priorTargetState = this.targetStates.get(targetId);
    const processingRateEvidence = this.prehistoryCandidateTargets.has(targetId)
      || priorTargetState?.lifecycle === "active"
      || priorTargetState?.lifecycle === "recovering"
      || (this.postClearUntilByTarget.get(targetId) ?? 0) > Date.parse(timestamp);
    if (!synthetic && processingRateEvidence && priorTargetState) {
      this.recordEvidenceFrame(targetId, frame, this.relativeMetrics(frame, receiverMetric), priorTargetState);
    }

    active!.visit.confirmedAt ??= frame.tuneConfirmedAt;
    active!.visit.settledAt ??= timestamp;
    active!.visit.confirmedCenterHz = frame.confirmedCenterHz;
    active!.visit.confirmedSampleRateHz = frame.confirmedSampleRateHz;
    active!.visit.discardedFrames = transport?.discardedFrames ?? active!.visit.discardedFrames;
    const analysisFrame: SpectrumFrame = { ...frame, bins: bins.slice(analysisStartBin, analysisEndBin) };
    active!.frames.push(analysisFrame);
    if (active!.frames.length > 5) active!.frames.shift();
    active!.visit.acceptedFrames = active!.frames.length;
    active!.visit.firstAcceptedAt = active!.frames[0]?.timestamp;
    active!.visit.lastAcceptedAt = active!.frames.at(-1)?.timestamp;
    const minimumFrames = target!.minFreshFrames ?? 3;
    if (active!.frames.length < minimumFrames) {
      const pendingState = this.targetStates.get(targetId) ?? { ...this.clearTargetState(targetId), observationDisposition: "unknown" as const };
      this.publishFrame(frame, basicMetrics, pendingState);
      return;
    }

    if (synthetic) {
      const analysis = this.syntheticExercise?.analyzeVisit(
        active!.frames,
        synthetic.sensorState.configurationOffset,
        synthetic.sensorState.overload,
      );
      if (!analysis?.result) {
        this.completeSyntheticUnknownVisit(assignment!, analysis?.unknownReason ?? "insufficient-frames");
        return;
      }
      const result = analysis.result;
      frame.detectorAnalysis = projectDetectorAnalysisToFrame({
        analysis: result.analysis,
        frameBinCount: frame.bins.length,
        analysisStartBin: frame.analysisStartBin,
        analysisEndBin: frame.analysisEndBin,
      });
      if (result.event) {
        result.event.affectedBandIds = [...new Set(coverage.map((item) => item.band.id))];
        result.event.affectedLabel = [...new Set(coverage.map((item) => {
          const relatedBand = item.band;
          return relatedBand.service === "gnss" ? [relatedBand.constellation, relatedBand.signal].filter(Boolean).join(" ") : relatedBand.label;
        }))].join(" / ");
      }
      const targetState = this.updateTargetState(receiverId, targetId, result, timestamp, synthetic.marker);
      const event = targetState.eventId ? this.events.find((candidate) => candidate.id === targetState.eventId) : undefined;
      this.recordEvidenceFrame(targetId, frame, result.metrics, targetState);
      this.publishFrame(frame, result.metrics, targetState, event);
      this.syntheticExercise?.observeTargetState(targetState);
      this.completeSyntheticVisit(assignment!, active!, timestamp);
      return;
    }

    const fingerprint = this.baselineFingerprintFor(receiverId, target!, bins.length, analysisStartBin, analysisEndBin);
    if (!fingerprint) {
      this.publishFrame(frame, basicMetrics, this.targetStates.get(targetId) ?? this.clearTargetState(targetId));
      this.completeUnknownVisit(assignment!, "receiver-unhealthy");
      return;
    }
    const outcome = aggregateVisitFrames({
      frames: active!.frames,
      targetId,
      visitId: active!.visit.id,
      configurationEpoch: active!.visit.configurationEpoch,
      tuneEpoch: active!.visit.tuneEpoch,
      visitEpoch: active!.visit.visitEpoch,
      affectedBandIds: coverage.map((item) => item.band.id),
      fingerprint,
      overload: receiverMetric.overload,
      healthComplete: this.observationHealthComplete(receiverId, source),
    });
    if (outcome.status === "unknown") {
      this.publishFrame(frame, basicMetrics, this.targetStates.get(targetId) ?? this.clearTargetState(targetId));
      this.completeUnknownVisit(assignment!, outcome.reason);
      return;
    }
    const freezeTraining = this.activeEventsByTarget.has(targetId)
      || this.prehistoryCandidateTargets.has(targetId)
      || receiverMetric.overload
      || this.resourcePressureActive
      || this.applicationRecoveryActive
      || this.receiverRecoveryActive
      || performance.now() < this.receiverStartupGraceUntil
      || !this.evidenceHealthy;
    const result = this.detector.analyzeObservation(outcome.observation, band, {
      freezeTraining,
      referenceBaseline: this.persistentBaselineReference(outcome.observation.fingerprint, true),
      requireReferenceBaseline: true,
    });
    frame.detectorAnalysis = projectDetectorAnalysisToFrame({
      analysis: result.analysis,
      frameBinCount: frame.bins.length,
      analysisStartBin: frame.analysisStartBin,
      analysisEndBin: frame.analysisEndBin,
    });
    result.metrics.vendorReportedSignalPower = receiverMetric.vendorReportedSignalPower;
    result.metrics.snrDb = receiverMetric.snrDb;
    this.spectrumFramesAnalyzed += 1;
    this.updatePersistentBaseline(
      outcome.observation.fingerprint,
      outcome.observation.bins,
      outcome.observation.exposureMs,
      result,
      result.trainingEligible ? undefined : this.baselineRejectionReason(targetId, result, outcome.observation.healthComplete, receiverMetric.overload),
    );
    if (result.candidate && !this.prehistoryCandidateTargets.has(targetId)) {
      this.prehistoryCandidateTargets.add(targetId);
      if (!this.prehistoryFrozenReceivers.has(receiverId)) {
        this.prehistoryFrozenReceivers.add(receiverId);
        this.flushPrehistory(receiverId, frame.id);
      }
    } else if (!result.candidate && (
      result.disposition === "clean"
      || (result.disposition === "unknown" && result.baseline.lifecycle === "learning" && !result.unknownReason)
    )) {
      this.prehistoryCandidateTargets.delete(targetId);
      this.releasePrehistoryFreeze(receiverId, Date.parse(timestamp));
    }
    if (result.event) {
      result.event.affectedBandIds = [...new Set(coverage.map((item) => item.band.id))];
      result.event.affectedLabel = [...new Set(coverage.map((item) => {
        const relatedBand = item.band;
        return relatedBand.service === "gnss" ? [relatedBand.constellation, relatedBand.signal].filter(Boolean).join(" ") : relatedBand.label;
      }))].join(" / ");
    }
    const targetState = this.updateTargetState(receiverId, targetId, result, timestamp);
    const event = targetState.eventId ? this.events.find((candidate) => candidate.id === targetState.eventId) : undefined;
    this.recordEvidenceFrame(targetId, frame, result.metrics, targetState);
    this.publishFrame(frame, result.metrics, targetState, event);
    active!.visit.completedAt = timestamp;
    active!.visit.outcome = "valid";
    const exposureMs = outcome.observation.exposureMs;
    const completedAtMonotonicMs = performance.now();
    // Use the accepted frame order directly. Host UTC timestamps can repeat at
    // millisecond resolution and must not collapse the monotonic exposure span.
    const firstObservedAtMs = active!.frames[0]?.receivedMonotonicMs;
    const lastObservedAtMs = active!.frames.at(-1)?.receivedMonotonicMs;
    const completion = assignment!.scheduler.completeActive({
      valid: true,
      completedAtMs: completedAtMonotonicMs,
      observedExposureMs: Math.min(exposureMs, completedAtMonotonicMs - active!.startedMonotonicMs),
      ...(firstObservedAtMs !== undefined && lastObservedAtMs !== undefined ? { firstObservedAtMs, lastObservedAtMs } : {}),
    });
    this.recordTimingCompletion(completion);
    Object.assign(active!.visit, {
      observedExposureMs: completion.observedExposureMs,
      revisitMs: completion.revisitMs,
      actualUnobservedGapMs: completion.actualUnobservedGapMs,
      visitDurationMs: completion.durationMs,
      missedObjective: completion.missedObjective,
      missByMs: completion.missByMs,
    });
    if (target!.id === "gnss-l1-e1-b1c-sbas" && completion.revisitMs !== undefined) {
      this.measuredPriorityGapMs = Math.max(this.measuredPriorityGapMs ?? 0, completion.revisitMs);
    }
    if (assignment!.timer) clearTimeout(assignment!.timer);
    assignment!.active = undefined;
    if (this.evidenceHealthy) void this.evidence.recordOperationalAction({ type: "target-visit-completed", visit: active!.visit }).catch((error) => this.markStorageError(error));
    this.scheduleAssignment(assignment!);
  }

  private relativeMetrics(frame: SpectrumFrame, receiverMetric: ReceiverMetricState): SignalMetricSample {
    let total = 0;
    let peak = 0;
    for (const value of frame.bins) { total += value; peak = Math.max(peak, value); }
    const mean = frame.bins.length ? total / frame.bins.length : 0;
    return {
      timestamp: frame.timestamp,
      bandId: frame.bandId,
      meanLevel: Number(mean.toFixed(2)),
      peakLevel: peak,
      baselineLevel: Number(mean.toFixed(2)),
      baselineDelta: 0,
      occupiedRatio: 0,
      vendorReportedSignalPower: receiverMetric.vendorReportedSignalPower,
      snrDb: receiverMetric.snrDb,
      overload: receiverMetric.overload,
    };
  }

  private publishFrame(frame: SpectrumFrame, metrics: SignalMetricSample, targetState: ChannelMonitorState, event?: DetectionEvent): void {
    this.currentFrame = frame;
    this.currentMetrics = metrics;
    this.waterfall = [...this.waterfall.slice(-31), frame];
    this.frameByTarget.set(frame.targetId!, frame);
    this.metricsByTarget.set(frame.targetId!, metrics);
    this.waterfallByTarget.set(frame.targetId!, [...(this.waterfallByTarget.get(frame.targetId!) ?? []).slice(-31), frame]);
    this.recordSweepFrame(frame);
    this.emit("message", { type: "frame", payload: { frame, metrics, event, targetState } } satisfies ServiceMessage);
  }

  private baselineFingerprintFor(receiverId: number, target: CompiledScanTarget, inputBinCount: number, analysisStartBin: number, analysisEndBin: number) {
    if (inputBinCount <= 0 || analysisEndBin <= analysisStartBin) return undefined;
    const receiver = this.receiverStates[receiverId];
    const metrics = this.receiverMetrics.get(receiverId);
    return createBaselineFingerprint({
      dataDomain: this.config.dataDomain,
      receiverIdentity: receiver?.deviceSerial
        ? `serial:${receiver.deviceSerial}`
        : `endpoint:${receiver?.url ?? `receiver-${receiverId}`}|device:${receiver?.deviceName ?? "unknown"}`,
      receiverKey: receiver?.url ?? `receiver-${receiverId}`,
      deviceName: receiver?.deviceName ?? "unknown",
      ...(receiver?.deviceSerial ? { deviceSerial: receiver.deviceSerial } : {}),
      sdrconnectVersion: receiver?.apiVersion ?? "unknown",
      activeAntenna: metrics?.activeAntenna ?? "unknown",
      gainProfileId: metrics?.gainProfileId ?? "unknown",
      targetId: target.id,
      centerHz: target.centerHz,
      sampleRateHz: this.config.sampleRateHz,
      inputBinCount,
      analysisStartBin,
      analysisEndBin,
      analysisMaskHash: `central:${analysisStartBin}:${analysisEndBin}`,
      spectrumReference: metrics?.spectrumReference ?? 0,
      spectrumBase: metrics?.spectrumBase ?? 0,
      catalogVersion: this.config.bandCatalog.catalogVersion,
      detectionRuleHash: detectionRuleFingerprint(this.config.detectionThresholds),
    });
  }

  private fingerprintHealthComplete(receiverId: number, source: SpectrumFrame["source"]): boolean {
    if (source === "simulation") return true;
    const receiver = this.receiverStates[receiverId];
    const metrics = this.receiverMetrics.get(receiverId);
    return Boolean(
      parseSdrconnectDeviceModel(receiver?.deviceName)
      && normalizeReceiverSerial(receiver?.deviceSerial)
      && receiver.apiVersion
      && metrics?.activeAntenna?.trim()
      && metrics.gainProfileId
      && metrics.lnaState?.trim()
      && Number.isFinite(metrics.spectrumReference)
      && Number.isFinite(metrics.spectrumBase),
    );
  }

  private observationHealthComplete(receiverId: number, source: SpectrumFrame["source"]): boolean {
    if (source === "simulation") return true;
    const receiver = this.receiverStates[receiverId];
    const metrics = this.receiverMetrics.get(receiverId);
    return Boolean(
      receiver?.deviceReady
      && receiver.streamReady
      && parseSdrconnectDeviceModel(receiver.deviceName)
      && normalizeReceiverSerial(receiver.deviceSerial)
      && receiver.apiVersion
      && receiver.confirmedSampleRateHz === this.config.sampleRateHz
      && metrics?.activeAntenna?.trim(),
    );
  }

  private updatePersistentBaseline(
    fingerprint: ReturnType<typeof createBaselineFingerprint>,
    bins: Uint8Array,
    exposureMs: number,
    result: DetectionResult,
    rejectionReason?: StoredBaselineRejectionReason,
  ): void {
    if (!this.baselineStore) return;
    try {
      const stored = fingerprint as unknown as StoredBaselineFingerprint;
      const fingerprintId = BaselineStore.fingerprintId(stored);
      this.selectActiveBaselineFingerprint(fingerprint.targetId, fingerprintId, stored);
      let descriptor = this.baselineStore.ensure(stored);
      const observedAtMs = Date.parse(result.metrics.timestamp);
      const lastTrainingAtMs = this.lastBaselineTrainingAtByTarget.get(fingerprint.targetId) ?? 0;
      const timeDecimated = Number.isFinite(observedAtMs)
        && observedAtMs - lastTrainingAtMs >= this.config.evidenceFrameIntervalMs;
      if (descriptor.lifecycle !== "protected" && timeDecimated && result.trainingEligible) {
        descriptor = this.baselineStore.observe(stored, bins, {
          observedAt: result.metrics.timestamp,
          exposureMs,
        });
        this.lastBaselineTrainingAtByTarget.set(fingerprint.targetId, observedAtMs);
      } else if (descriptor.lifecycle !== "protected" && timeDecimated && !result.trainingEligible) {
        // Quarantined candidates, health gaps, overload and adaptation freezes
        // are expected opportunities but never clean learning observations.
        descriptor = this.baselineStore.recordGap(stored, {
          observedAt: result.metrics.timestamp,
          reason: rejectionReason ?? "detector-quarantine",
        });
        this.lastBaselineTrainingAtByTarget.set(fingerprint.targetId, observedAtMs);
      }
      result.baseline = {
        dataDomain: this.config.dataDomain,
        targetId: descriptor.targetId,
        lifecycle: descriptor.lifecycle,
        fingerprintId: descriptor.fingerprintId,
        baselineId: descriptor.lifecycle === "protected" ? `${descriptor.fingerprintId}:${descriptor.generation}` : undefined,
        learningGenerationId: String(descriptor.generation),
        observationCount: descriptor.totalValidObservations,
        validCoverageRatio: descriptor.coverageRatio,
        representativeHours: descriptor.representativeUtcHours,
        learningStartedAt: descriptor.firstObservationAt ?? descriptor.createdAt,
        protectedAt: descriptor.protectedAt,
        reason: descriptor.lifecycle === "learning" ? "Collecting at least 30 minutes and sufficient valid visits." : undefined,
        learningExclusions: descriptor.learningExclusions,
      };
      if (result.event) {
        result.event.baselineFingerprintId = descriptor.fingerprintId;
        result.event.baselineId = result.baseline.baselineId;
        result.event.baselineGenerationId = String(descriptor.generation);
        result.event.evidenceStrength = descriptor.lifecycle === "protected" ? "Medium" : "Low";
        result.event.evidenceBasis = descriptor.lifecycle === "protected"
          ? "Repeated relative RF anomaly against an approved exact-configuration baseline."
          : "Relative RF anomaly from an unapproved or provisional baseline.";
      }
      this.baselineHealthy = this.baselineRestartTargets.size === 0;
    } catch (error) {
      this.baselineHealthy = false;
      this.emitServiceError(error instanceof Error ? error.message : String(error));
    }
  }

  private persistentBaselineReference(
    fingerprint: ReturnType<typeof createBaselineFingerprint>,
    ensureActive = false,
  ): DetectionBaselineReference | undefined {
    if (!this.baselineStore) return undefined;
    try {
      const stored = fingerprint as unknown as StoredBaselineFingerprint;
      const fingerprintId = BaselineStore.fingerprintId(stored);
      if (ensureActive) {
        this.baselineStore.ensure(stored);
        this.selectActiveBaselineFingerprint(fingerprint.targetId, fingerprintId, stored);
      }
      const selected = this.baselineStore.resolve(stored);
      if (selected.lifecycle === "stale") return undefined;
      return {
        descriptor: this.publicBaselineDescriptor(selected.baseline),
        medians: selected.baseline.median,
        mads: selected.baseline.mad,
      };
    } catch (error) {
      this.baselineHealthy = false;
      this.emitServiceError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  private publicBaselineDescriptor(descriptor: StoredBaselineDescriptor): BaselineDescriptor {
    return {
      dataDomain: descriptor.fingerprint.dataDomain as "field" | "test",
      targetId: descriptor.targetId,
      lifecycle: descriptor.lifecycle,
      fingerprintId: descriptor.fingerprintId,
      baselineId: descriptor.lifecycle === "protected" ? `${descriptor.fingerprintId}:${descriptor.generation}` : undefined,
      learningGenerationId: String(descriptor.generation),
      observationCount: descriptor.totalValidObservations,
      validCoverageRatio: descriptor.coverageRatio,
      representativeHours: descriptor.representativeUtcHours,
      learningStartedAt: descriptor.firstObservationAt ?? descriptor.createdAt,
      protectedAt: descriptor.protectedAt,
      reason: descriptor.lifecycle === "learning" ? "Collecting at least 30 minutes and sufficient valid visits." : undefined,
      learningExclusions: descriptor.learningExclusions,
    };
  }

  private baselineRejectionReason(
    targetId: string,
    result: DetectionResult,
    healthComplete: boolean,
    receiverOverload: boolean,
  ): StoredBaselineRejectionReason {
    if (receiverOverload || result.metrics.overload) return "receiver-overload";
    if (this.hostMemoryPressureActive) return "host-memory-pressure";
    if (this.applicationRecoveryActive) return "application-recovery";
    if (performance.now() < this.receiverStartupGraceUntil) return "receiver-startup-grace";
    if (this.receiverRecoveryActive) return "receiver-recovery";
    if (this.resourcePressureActive) return "resource-pressure";
    if (!this.evidenceHealthy) return "evidence-unavailable";
    if (this.activeEventsByTarget.has(targetId)) return "target-event";
    if (this.prehistoryCandidateTargets.has(targetId) || result.candidate) return "anomaly-candidate";
    if (!healthComplete) return "receiver-health-incomplete";
    return "detector-quarantine";
  }

  private selectActiveBaselineFingerprint(
    targetId: string,
    fingerprintId: string,
    fingerprint: StoredBaselineFingerprint,
  ): void {
    for (const key of this.activeBaselineFingerprints.keys()) {
      if (key.startsWith(`${targetId}:`) && key !== `${targetId}:${fingerprintId}`) {
        this.activeBaselineFingerprints.delete(key);
      }
    }
    this.activeBaselineFingerprints.set(`${targetId}:${fingerprintId}`, fingerprint);
    this.activeBaselineFingerprintIdByTarget.set(targetId, fingerprintId);
  }

  private recordEvidenceFrame(
    targetId: string,
    frame: PersistedSpectrumFrame,
    metrics: SignalMetricSample,
    targetState: ChannelMonitorState,
  ): void {
    if (this.reconfiguring || !this.evidenceHealthy) return;
    const now = Date.parse(frame.timestamp);
    const normalIntervalMs = this.config.evidenceFrameIntervalMs;
    const inPostClear = (this.postClearUntilByTarget.get(targetId) ?? 0) > now;
    const intervalMs = targetState.observationDisposition === "anomalous" || targetState.lifecycle === "active" || targetState.lifecycle === "recovering" || inPostClear
      ? Math.min(normalIntervalMs, Math.round(1_000 / this.config.maxSpectrumRateHz))
      : normalIntervalMs;
    const lastRecordedAt = this.lastEvidenceFrameAtByTarget.get(targetId) ?? 0;
    if (now - lastRecordedAt < intervalMs) return;
    const estimatedBytes = frame.bins.byteLength + 2_048;
    if (
      this.evidenceWritesInFlight >= this.config.maxPendingEvidenceFrames
      || this.evidenceWriteBytesInFlight + estimatedBytes > 256 * 1024
    ) {
      this.evidenceFramesDropped += 1;
      if (!frame.syntheticExercise) {
        if (performance.now() >= this.commissioningStartedAtMonotonicMs) this.commissioningFaults.add("evidence-frame-drop");
        else this.commissioningEvidenceFramesDroppedAtStart = this.evidenceFramesDropped;
      }
      return;
    }
    this.lastEvidenceFrameAtByTarget.set(targetId, now);
    const writeStartedAt = Date.now();
    this.evidenceWritesInFlight += 1;
    this.evidenceWriteBytesInFlight += estimatedBytes;
    this.evidenceWriteStartedAt.push(writeStartedAt);
    const baseline = frame.syntheticExercise ? undefined : this.getBaselineStates()
      .filter((candidate) => candidate.targetId === targetId)
      .sort((left, right) => Number(right.learningGenerationId) - Number(left.learningGenerationId))[0];
    void this.evidence.recordFrame(frame, {
      ...metrics,
      configurationId: this.config.configurationHash,
      configurationEpoch: frame.configurationEpoch,
      catalogVersion: this.config.bandCatalog.catalogVersion,
      ruleSetId: this.config.detectionThresholds.ruleSetId,
      baselineId: baseline?.baselineId,
      baselineFingerprintId: baseline?.fingerprintId,
      baselineSource: frame.syntheticExercise ? "ephemeral-synthetic-quiet-seed" : undefined,
      affectedBandIds: this.assignments.flatMap((assignment) => assignment.targets).find((target) => target.id === targetId)?.coverage.map((item) => item.band.id) ?? [frame.bandId],
      calibrationState: frame.calibrated ? "calibrated" : "uncalibrated-relative",
      inputBinCount: frame.inputBinCount,
      storedBinCount: frame.bins.length,
      binning: frame.binning,
    }).then(() => {
      this.evidenceFramesRecorded += 1;
      this.evidenceWriteSamples.push({ at: Date.now(), bytes: estimatedBytes });
      // Session byte and age caps are hard bounds. The periodic retention pass is
      // only a fallback; a completed append that crosses a cap triggers rotation
      // immediately, limiting overshoot to the current reduced frame record.
      if (this.evidence.shouldRotate(
        this.config.retentionPolicy.sessionMaxBytes,
        this.config.retentionPolicy.sessionMaxMs,
      )) void this.runStorageMaintenance();
    }).catch((error) => this.markStorageError(error)).finally(() => {
      this.evidenceWritesInFlight = Math.max(0, this.evidenceWritesInFlight - 1);
      this.evidenceWriteBytesInFlight = Math.max(0, this.evidenceWriteBytesInFlight - estimatedBytes);
      const startedIndex = this.evidenceWriteStartedAt.indexOf(writeStartedAt);
      if (startedIndex >= 0) this.evidenceWriteStartedAt.splice(startedIndex, 1);
    });
  }

  private pushSpectrumRing(frame: PersistedSpectrumFrame): void {
    const ring = this.spectrumRingByReceiver.get(frame.receiver) ?? [];
    ring.push(frame);
    const cutoff = Date.parse(frame.timestamp) - 60_000;
    while (ring.length > 240 || (ring[0] && Date.parse(ring[0].timestamp) < cutoff)) ring.shift();
    this.spectrumRingByReceiver.set(frame.receiver, ring);
  }

  private flushPrehistory(receiverId: number, excludeFrameId?: string): void {
    if (this.reconfiguring || !this.evidenceHealthy) return;
    const frames = [...(this.spectrumRingByReceiver.get(receiverId) ?? [])]
      .filter((frame) => frame.id !== excludeFrameId)
      .slice(-240);
    if (!frames.length) return;
    const estimatedBytes = frames.reduce((total, frame) => total + frame.bins.byteLength + 2_048, 0);
    void this.evidence.recordPrehistory(frames.map((frame) => ({
      frame,
      summary: {
        ...this.relativeMetrics(frame, this.receiverMetrics.get(frame.receiver) ?? { overload: false }),
        evidencePhase: "prehistory",
        configurationId: this.config.configurationHash,
        configurationEpoch: frame.configurationEpoch,
        catalogVersion: this.config.bandCatalog.catalogVersion,
        ruleSetId: this.config.detectionThresholds.ruleSetId,
        calibrationState: frame.calibrated ? "calibrated" : "uncalibrated-relative",
      },
    }))).then(() => {
      this.evidenceFramesRecorded += frames.length;
      this.evidenceWriteSamples.push({ at: Date.now(), bytes: estimatedBytes });
    }).catch((error) => this.markStorageError(error));
  }

  private releasePrehistoryFreeze(receiverId: number, now: number): void {
    const assignment = this.assignments.find((candidate) => candidate.receiver === receiverId);
    const receiverTargetIds = new Set(assignment?.targets.map((target) => target.id) ?? []);
    const stillHot = [...receiverTargetIds].some((targetId) => (
      this.prehistoryCandidateTargets.has(targetId)
      || this.activeEventsByTarget.has(targetId)
      || (this.postClearUntilByTarget.get(targetId) ?? 0) > now
    ));
    if (!stillHot) this.prehistoryFrozenReceivers.delete(receiverId);
  }

  private updateTargetState(
    receiverId: number,
    targetId: string,
    result: DetectionResult,
    timestamp: string,
    syntheticExercise?: SyntheticExerciseMarker,
  ): ChannelMonitorState {
    const previous = this.targetStates.get(targetId) ?? this.clearTargetState(targetId);
    const requiredCount = this.config.detectionThresholds.clearObservations;
    let next: ChannelMonitorState;
    if (result.disposition === "unknown" && result.candidate) {
      next = {
        targetId,
        lifecycle: "detecting",
        candidateCount: result.candidate.count,
        clearCount: 0,
        requiredCount: result.candidate.required,
        firstSeenAt: previous.lifecycle === "clear" ? timestamp : previous.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        lastObservedAt: timestamp,
        kind: result.candidate.kind,
        observationDisposition: "unknown",
        baselineLifecycle: result.baseline.lifecycle,
      };
    } else if (result.disposition === "unknown") {
      next = previous.lifecycle === "active" || previous.lifecycle === "recovering"
        ? { ...previous, observationDisposition: "unknown", baselineLifecycle: result.baseline.lifecycle }
        : {
            ...previous,
            lifecycle: "detecting",
            candidateCount: 0,
            requiredCount: this.config.detectionThresholds.interferenceHits,
            lastObservedAt: timestamp,
            observationDisposition: "unknown",
            baselineLifecycle: result.baseline.lifecycle,
          };
    } else if (result.event) {
      const event = this.upsertEvent(receiverId, targetId, {
        ...result.event,
        targetId,
        lifecycle: "active",
        startedAt: previous.firstSeenAt ?? result.event.startedAt,
      }, syntheticExercise);
      next = {
        targetId,
        lifecycle: "active",
        candidateCount: result.candidate?.count ?? requiredCount,
        clearCount: 0,
        requiredCount,
        firstSeenAt: previous.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        lastObservedAt: timestamp,
        eventId: event.id,
        kind: event.kind,
        status: event.status,
        evidenceStrength: event.evidenceStrength,
        baselineLifecycle: result.baseline.lifecycle,
        observationDisposition: "anomalous",
      };
    } else if (result.candidate && (previous.lifecycle === "active" || previous.lifecycle === "recovering")) {
      next = {
        ...previous,
        lifecycle: "active",
        candidateCount: result.candidate.count,
        clearCount: 0,
        lastSeenAt: timestamp,
        lastObservedAt: timestamp,
        observationDisposition: "anomalous",
        baselineLifecycle: result.baseline.lifecycle,
      };
    } else if (result.candidate) {
      next = {
        targetId,
        lifecycle: "detecting",
        candidateCount: result.candidate.count,
        clearCount: 0,
        requiredCount: result.candidate.required,
        firstSeenAt: previous.lifecycle === "clear" ? timestamp : previous.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        lastObservedAt: timestamp,
        kind: result.candidate.kind,
        observationDisposition: "anomalous",
        baselineLifecycle: result.baseline.lifecycle,
      };
    } else if (result.disposition === "clean" && (previous.lifecycle === "active" || previous.lifecycle === "recovering")) {
      const clearCount = previous.clearCount + 1;
      const event = previous.eventId ? this.events.find((candidate) => candidate.id === previous.eventId) : undefined;
      if (clearCount >= requiredCount) {
        if (event) {
          event.lifecycle = "cleared";
          event.clearedAt = timestamp;
          this.activeEventsByTarget.delete(targetId);
          if (!event.syntheticExercise) {
            this.postClearUntilByTarget.set(targetId, Date.parse(timestamp) + 10 * 60_000);
          }
          if (this.evidenceHealthy) void this.persistEvent({ ...event }).catch((error) => this.markStorageError(error));
        }
        next = { ...this.clearTargetState(targetId), requiredCount, lastObservedAt: timestamp, clearedAt: timestamp, observationDisposition: "clean", baselineLifecycle: result.baseline.lifecycle };
      } else {
        if (event) event.lifecycle = "recovering";
        next = { ...previous, lifecycle: "recovering", candidateCount: 0, clearCount, requiredCount, lastObservedAt: timestamp, observationDisposition: "clean", baselineLifecycle: result.baseline.lifecycle };
      }
    } else {
      next = { ...this.clearTargetState(targetId), requiredCount, lastObservedAt: timestamp, clearedAt: previous.clearedAt, observationDisposition: "clean", baselineLifecycle: result.baseline.lifecycle };
    }
    this.targetStates.set(targetId, next);
    this.refreshActiveEvent();
    if (
      previous.lifecycle !== next.lifecycle ||
      previous.candidateCount !== next.candidateCount ||
      previous.clearCount !== next.clearCount ||
      previous.eventId !== next.eventId
    ) this.broadcastSnapshot();
    return next;
  }

  private upsertEvent(
    receiverId: number,
    targetId: string,
    candidate: Omit<DetectionEvent, "id" | "sessionId" | "notes">,
    syntheticExercise?: SyntheticExerciseMarker,
  ): DetectionEvent {
    assertRfOnlyDetectionClaim(candidate);
    const existing = this.activeEventsByTarget.get(targetId);
    if (existing?.kind === candidate.kind) {
      Object.assign(existing, candidate, { startedAt: existing.startedAt, targetId, lifecycle: "active", clearedAt: undefined });
      this.refreshActiveEvent();
      return existing;
    }
    if (existing) {
      existing.lifecycle = "cleared";
      existing.clearedAt = candidate.startedAt;
      if (this.evidenceHealthy) void this.persistEvent({ ...existing }).catch((error) => this.markStorageError(error));
    }
    const event: DetectionEvent = {
      ...candidate,
      targetId,
      lifecycle: "active",
      id: randomUUID(),
      sessionId: syntheticExercise ? `synthetic:${syntheticExercise.runId}` : this.evidence.currentSession?.id ?? "storage-unavailable",
      sessionIds: syntheticExercise ? [] : this.evidence.currentSession ? [this.evidence.currentSession.id] : [],
      notes: [],
      syntheticExercise,
    };
    this.activeEventsByTarget.set(targetId, event);
    this.events = [event, ...this.events].slice(0, 100);
    this.refreshActiveEvent();
    if (this.evidenceHealthy) void this.persistEvent(event).catch((error) => this.markStorageError(error));
    return event;
  }

  private baselineReferenceFor(event: DetectionEvent): object | undefined {
    const explicitGeneration = Number(event.baselineGenerationId);
    const protectedGeneration = event.baselineId?.match(/:([1-9][0-9]*)$/)?.[1];
    const generation = Number.isSafeInteger(explicitGeneration) && explicitGeneration > 0
      ? explicitGeneration
      : protectedGeneration ? Number(protectedGeneration) : undefined;
    if (!generation) return undefined;
    return this.baselineStore?.evidenceReference(event.baselineFingerprintId, generation);
  }

  private persistEvent(event: DetectionEvent, destinationSessionId?: string): Promise<void> {
    if (!event.syntheticExercise) {
      return this.evidence.recordEvent(event, destinationSessionId, this.baselineReferenceFor(event));
    }
    const evidenceSessionId = destinationSessionId ?? this.evidence.currentSession?.id;
    if (!evidenceSessionId) return Promise.reject(new Error("Synthetic test evidence has no active test-domain session"));
    const evidenceEvent: DetectionEvent = {
      ...event,
      sessionId: evidenceSessionId,
      sessionIds: [evidenceSessionId],
    };
    return this.evidence.recordEvent(evidenceEvent, evidenceSessionId, this.baselineReferenceFor(evidenceEvent));
  }

  private refreshActiveEvent(): void {
    const severityRank = { high: 3, medium: 2, low: 1 } as const;
    this.activeEvent = [...this.activeEventsByTarget.values()].sort((left, right) =>
      severityRank[right.severity] - severityRank[left.severity] || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    )[0];
  }

  private clearTargetState(targetId: string): ChannelMonitorState {
    return {
      targetId,
      lifecycle: "clear",
      candidateCount: 0,
      clearCount: 0,
      requiredCount: this.config.detectionThresholds.clearObservations,
      observationDisposition: "unknown",
    };
  }

  private getMonitorTargets(): MonitorTarget[] {
    const targets = new Map<string, MonitorTarget>();
    for (const assignment of this.assignments) {
      const surveyRevisitMs = Math.max(1, assignment.targets.reduce((total, target) => total + target.dwellMs, 0));
      const describedTargets = assignment.targets.map((target) => ({
        target,
        priority: target.tier === "tier1",
        expectedRevisitMs: target.revisitObjectiveMs ?? surveyRevisitMs,
      }));
      for (const { target, priority, expectedRevisitMs } of describedTargets) {
        const described = { ...describeMonitorTarget(target), priority, expectedRevisitMs };
        const current = targets.get(described.id);
        if (!current) {
          targets.set(described.id, described);
          continue;
        }
        const relatedBandIds = [...new Set([...current.relatedBandIds, ...described.relatedBandIds])];
        const labels = [...new Set(relatedBandIds.map((bandId) => this.config.bands.find((band) => band.id === bandId)?.label).filter((label): label is string => Boolean(label)))];
        targets.set(described.id, {
          ...current,
          relatedBandIds,
          label: labels.join(" / "),
          priority: current.priority || described.priority,
          expectedRevisitMs: Math.min(current.expectedRevisitMs, described.expectedRevisitMs),
        });
      }
    }
    return [...targets.values()].sort((left, right) => {
      if (left.priority !== right.priority) return left.priority ? -1 : 1;
      if (left.service === "gnss" && right.service !== "gnss") return -1;
      if (left.service !== "gnss" && right.service === "gnss") return 1;
      return left.startHz - right.startHz;
    });
  }

  private handleProperty(receiverId: number, message: SdrconnectPropertyMessage): void {
    if (!message.property) return;
    const receiver = this.receiverStates[receiverId];
    const metrics = this.receiverMetrics.get(receiverId) ?? { overload: false };
    const value = message.value;
    if (message.property === "signal_power") metrics.vendorReportedSignalPower = Number(value);
    if (message.property === "signal_snr") metrics.snrDb = Number(value);
    if (message.property === "overload") metrics.overload = value === true || value === "true" || value === 1;
    if (message.property === "active_antenna") {
      const activeAntenna = String(value ?? "").trim();
      metrics.activeAntenna = activeAntenna;
      receiver.activeAntenna = activeAntenna || undefined;
    }
    if (message.property === "gain_reduction") metrics.gainReduction = String(value ?? "");
    if (message.property === "lna_state") metrics.lnaState = String(value ?? "");
    if (message.property === "if_gain") metrics.ifGain = String(value ?? "");
    if (["gain_reduction", "lna_state", "if_gain"].includes(message.property)) {
      metrics.gainProfileId = JSON.stringify({
        ...(metrics.gainReduction !== undefined ? { gainReduction: metrics.gainReduction } : {}),
        ...(metrics.lnaState !== undefined ? { lnaState: metrics.lnaState } : {}),
        ...(metrics.ifGain !== undefined ? { ifGain: metrics.ifGain } : {}),
      });
    }
    if (["spectrum_ref_level", "spectrum_reference", "spectrum_reference_level"].includes(message.property)) metrics.spectrumReference = Number(value);
    if (["spectrum_base", "spectrum_base_level"].includes(message.property)) metrics.spectrumBase = Number(value);
    if (message.property === "active_device") {
      receiver.deviceName = String(value ?? "");
      receiver.deviceReady = Boolean(parseSdrconnectDeviceModel(receiver.deviceName));
      receiver.deviceSerial ??= parseSdrconnectDeviceSerial(receiver.deviceName);
    }
    if (message.property === "device_center_frequency" && Number.isFinite(Number(value))) receiver.confirmedCenterHz = Number(value);
    if (message.property === "device_sample_rate" && Number.isFinite(Number(value))) receiver.confirmedSampleRateHz = Number(value);
    if (message.property === "device_serial") receiver.deviceSerial = String(value ?? "");
    if (message.property === "api_version") { receiver.apiVersion = String(value ?? ""); receiver.apiReady = Boolean(receiver.apiVersion); }
    this.receiverMetrics.set(receiverId, metrics);
    if (!this.reconfiguring && this.evidenceHealthy && this.sdrMetadataGate.shouldRecord(receiverId, message)) {
      void this.evidence.recordMetadata(receiverId, message).catch((error) => this.markStorageError(error));
      if (this.sdrMetadataGate.shouldCheckpointContext(message)) this.scheduleSessionContextCheckpoint();
    }
  }

  private startSimulation(): void {
    if (this.config.dataDomain !== "test") throw new Error("Simulation cannot start in the field data domain");
    if (this.simulator) return;
    if (!this.receiverStates.length) this.receiverStates.push({ id: 0, url: "simulation://local", connection: "simulated" });
    for (const receiver of this.receiverStates) receiver.connection = "simulated";
    this.simulator = setInterval(() => {
      for (const receiver of this.receiverStates) {
        if (this.syntheticExercise?.isExpired()) {
          this.clearSyntheticExercise();
        }
        const assignment = this.assignments.find((candidate) => candidate.receiver === receiver.id);
        const active = assignment?.active;
        const syntheticSample = this.syntheticExercise?.sample(active?.target.id, active?.visit.id);
        if (syntheticSample) {
          if (syntheticSample.bins) {
            this.handleSpectrum(receiver.id, syntheticSample.bins, "simulation", undefined, syntheticSample);
          }
          // An explicit data gap deliberately emits no frame. The visit timeout
          // records Unknown through the synthetic-only path below.
          continue;
        }
        const band = this.config.bands.find((candidate) => candidate.id === receiver.activeBandId) ?? this.config.bands[0];
        if (!band) continue;
        this.handleSpectrum(receiver.id, this.createSimulatedBins(band), "simulation");
      }
    }, 250);
  }

  private stopSimulation(): void {
    if (!this.simulator) return;
    clearInterval(this.simulator);
    this.simulator = undefined;
  }

  private clearSyntheticExercise(broadcast = true): void {
    const exercise = this.syntheticExercise;
    if (!exercise) return;
    const runId = exercise.marker.runId;
    for (const assignment of this.assignments) {
      const active = assignment.active;
      if (!active || !exercise.ownsVisit(active.target.id, active.visit.id)) continue;
      if (assignment.timer) clearTimeout(assignment.timer);
      try {
        assignment.scheduler.completeActive({ valid: false, completedAtMs: performance.now(), cause: "synthetic-exercise-ended" });
      } catch {
        // A stale timer can race cleanup; the assignment is reset below either way.
      }
      assignment.active = undefined;
      this.scheduleAssignment(assignment);
    }
    for (const [targetId, event] of this.activeEventsByTarget) {
      if (event.syntheticExercise?.runId === runId) this.activeEventsByTarget.delete(targetId);
    }
    this.events = this.events.filter((event) => event.syntheticExercise?.runId !== runId);
    const restore = this.syntheticRestore;
    const targetId = restore?.targetId ?? exercise.targetId;
    if (restore?.targetState) this.targetStates.set(targetId, restore.targetState);
    else this.targetStates.delete(targetId);
    if (restore?.frame) this.frameByTarget.set(targetId, restore.frame);
    else this.frameByTarget.delete(targetId);
    if (restore?.metrics) this.metricsByTarget.set(targetId, restore.metrics);
    else this.metricsByTarget.delete(targetId);
    if (restore?.waterfall.length) this.waterfallByTarget.set(targetId, restore.waterfall);
    else this.waterfallByTarget.delete(targetId);
    if (this.currentFrame?.syntheticExercise?.runId === runId) {
      const replacement = restore?.frame
        ?? [...this.frameByTarget.values()].filter((frame) => !frame.syntheticExercise).sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
      this.currentFrame = replacement;
      this.currentMetrics = replacement?.targetId ? this.metricsByTarget.get(replacement.targetId) : undefined;
      this.waterfall = replacement?.targetId ? [...(this.waterfallByTarget.get(replacement.targetId) ?? [])] : [];
    }
    this.syntheticExercise = undefined;
    this.syntheticRestore = undefined;
    this.refreshActiveEvent();
    if (restore?.frame && restore.metrics) {
      this.emit("message", {
        type: "frame",
        payload: { frame: restore.frame, metrics: restore.metrics, targetState: restore.targetState ?? this.clearTargetState(targetId) },
      } satisfies ServiceMessage);
    }
    if (broadcast) this.broadcastSnapshot();
  }

  private createSimulatedBins(band: BandPreset): Uint8Array {
    const count = (this.frameCounters.get(band.id) ?? 0) + 1;
    this.frameCounters.set(band.id, count);
    const bins = new Uint8Array(640);
    for (let index = 0; index < bins.length; index += 1) {
      const quiet = 28 + Math.round(6 * Math.sin(index * 0.31 + count * 0.17) + 3 * Math.sin(index * 0.07));
      let value = quiet;
      bins[index] = Math.max(0, Math.min(255, value));
    }
    return bins;
  }

  private expireIncident(): void {
    this.refreshActiveEvent();
  }

  private expireFocus(): void {
    if (this.activeFocus && Date.now() >= Date.parse(this.activeFocus.expiresAt)) void this.stopFocus("timeout");
  }

  private sessionMetadata(reason = "service-started") {
    const capturedAt = new Date().toISOString();
    return {
      config: {
        dataDomain: this.config.dataDomain,
        runtimeIdentity: this.config.runtimeIdentity,
        siteName: this.config.siteName,
        deploymentId: this.config.deploymentId,
        timestampPolicy: {
          storedAs: "UTC ISO-8601",
          displayTimeZone: this.config.displayTimeZone,
        },
        evidencePathPolicy: {
          hostPathStyle: path.sep === "\\" ? "windows" : "posix",
          archiveEntryPathStyle: "POSIX (/)",
          persistedSessionPath: "relative",
        },
        retentionPolicy: this.config.retentionPolicy,
        bands: this.config.bands,
        receiverUrls: this.config.receiverUrls.map((url) => url.replace(/\/\/.*@/, "//[redacted]@")),
        sampleRateHz: this.config.sampleRateHz,
        processingPolicy: {
          maxSpectrumRateHz: this.config.maxSpectrumRateHz,
          maxSpectrumBins: this.config.maxSpectrumBins,
          evidenceFrameIntervalMs: this.config.evidenceFrameIntervalMs,
          maxPendingEvidenceFrames: this.config.maxPendingEvidenceFrames,
        },
        simulation: this.config.simulation,
        detectionThresholds: this.config.detectionThresholds,
        configurationSources: this.config.configurationSources,
        catalogVersion: this.config.bandCatalog.catalogVersion,
        operationalSettings: this.config.operationalSettings,
        configurationRevision: this.config.operationalSettings.revision,
        configurationHash: this.config.configurationHash,
        sessionStartReason: reason,
      },
      sdrconnect: {
        capturedAt,
        snapshotReason: reason,
        connectedAtSnapshot: this.receiverStates.some((receiver) => receiver.socketConnected === true),
        sampleRatePolicy: "request configured rate when needed; accept frames only after SDRconnect confirmation",
        calibrationState: "uncalibrated-relative",
        iqEnabled: false,
        receivers: this.receiverStates.map((receiver) => {
          const metric = this.receiverMetrics.get(receiver.id);
          return {
            receiver: receiver.id,
            connection: receiver.connection,
            socketConnected: receiver.socketConnected ?? false,
            apiReady: receiver.apiReady ?? false,
            deviceReady: receiver.deviceReady ?? false,
            streamReady: receiver.streamReady ?? false,
            hardwareState: receiver.hardwareState,
            transportState: receiver.transportState,
            streamState: receiver.streamState,
            deviceName: receiver.deviceName,
            deviceSerial: receiver.deviceSerial,
            apiVersion: receiver.apiVersion,
            activeBandId: receiver.activeBandId,
            activeWindowId: receiver.activeWindowId,
            requestedCenterHz: receiver.tunedCenterHz,
            confirmedCenterHz: receiver.confirmedCenterHz,
            tuneState: receiver.tuneState,
            tuneConfirmedAt: receiver.tuneConfirmedAt,
            expectedSampleRateHz: this.config.sampleRateHz,
            confirmedSampleRateHz: receiver.confirmedSampleRateHz,
            activeAntenna: metric?.activeAntenna,
            gainProfileId: metric?.gainProfileId,
            gainReduction: metric?.gainReduction,
            lnaState: metric?.lnaState,
            ifGain: metric?.ifGain,
            spectrumReference: metric?.spectrumReference,
            spectrumBase: metric?.spectrumBase,
            vendorReportedSignalPower: metric?.vendorReportedSignalPower,
            overload: metric?.overload ?? false,
          };
        }),
      },
    };
  }

  private scheduleSessionContextCheckpoint(): void {
    if (this.reconfiguring || !this.evidenceHealthy || !this.evidence.currentSession) return;
    if (this.sessionContextTimer) clearTimeout(this.sessionContextTimer);
    this.sessionContextTimer = setTimeout(() => {
      this.sessionContextTimer = undefined;
      void this.checkpointSessionContext("receiver-state-update").catch((error) => this.markStorageError(error));
    }, 500);
    this.sessionContextTimer.unref();
  }

  private async checkpointSessionContext(reason: string): Promise<void> {
    if (this.sessionContextTimer) {
      clearTimeout(this.sessionContextTimer);
      this.sessionContextTimer = undefined;
    }
    if (!this.evidence.currentSession) return;
    await this.evidence.updateSdrconnectContext(this.sessionMetadata(reason).sdrconnect);
  }

  private async refreshSessionList(): Promise<void> {
    this.sessionList = await this.evidence.listSessions();
  }

  private lastStorageErrorLogAt = 0;
  private storageReprobeTimer: NodeJS.Timeout | undefined;

  private markStorageError(error?: unknown): void {
    const now = Date.now();
    if (now - this.lastStorageErrorLogAt >= 10_000) {
      this.lastStorageErrorLogAt = now;
      console.error(`Evidence write failed; recording marked unhealthy: ${error instanceof Error ? error.message : String(error ?? "unknown error")}`);
    }
    this.evidenceHealthy = false;
    // Writes stay off until a maintenance pass re-checks storage. After a failure, do that soon
    // instead of waiting for the next scheduled pass, so a transient fault costs seconds, not minutes.
    if (!this.storageReprobeTimer && !this.reconfiguring) {
      this.storageReprobeTimer = setTimeout(() => {
        this.storageReprobeTimer = undefined;
        void this.runStorageMaintenance().catch(() => undefined);
      }, 5_000);
      this.storageReprobeTimer.unref();
    }
    this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    // Spectrum frames can arrive much faster than a browser can usefully repaint.
    // Coalesce them so snapshots do not queue large waterfall payloads in memory.
    const minimumIntervalMs = 1_000;
    const elapsedMs = Date.now() - this.lastSnapshotBroadcastAt;
    if (elapsedMs >= minimumIntervalMs && !this.snapshotTimer) {
      this.emitSnapshot();
      return;
    }
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.emitSnapshot();
    }, Math.max(0, minimumIntervalMs - elapsedMs));
    this.snapshotTimer.unref();
  }

  private emitSnapshot(): void {
    this.lastSnapshotBroadcastAt = Date.now();
    const message: ServiceMessage = { type: "snapshot", payload: this.getSnapshot() };
    this.emit("message", message);
  }

  private emitServiceError(message: string): void {
    const payload: ServiceMessage = { type: "error", payload: { message } };
    this.emit("message", payload);
  }

  markRecoveryRequested(): void {
    for (const receiver of this.receiverStates) {
      receiver.recoveryState = receiver.hardwareState === "absent" ? "waiting-for-hardware" : "requested";
      receiver.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
    }
    this.broadcastSnapshot();
  }

  noteRecoverySupervisorStatus(status: RecoverySupervisorStatus): void {
    const recoveryWasActive = this.receiverRecoveryActive;
    this.receiverRecoveryActive = status.state === "requested" || status.state === "recovering" || status.state === "suppressed";
    if (this.receiverRecoveryActive && performance.now() >= this.commissioningStartedAtMonotonicMs) this.commissioningFaults.add("receiver-recovery");
    if (status.state === "lockout") this.commissioningFaults.add("receiver-recovery-lockout");
    if (recoveryWasActive && status.state === "live") this.restartCommissioningEpoch();
    let changed = false;
    for (const receiver of this.receiverStates) {
      const previousState = receiver.recoveryState;
      const previousRetryAt = receiver.nextRetryAt;
      if (status.state === "live") {
        receiver.recoveryState = receiver.streamReady ? "idle" : "recovering";
        receiver.nextRetryAt = undefined;
      } else if (status.state === "requested") {
        receiver.recoveryState = receiver.hardwareState === "absent" ? "waiting-for-hardware" : "requested";
        receiver.nextRetryAt = status.nextAttemptAt;
      } else if (status.state === "recovering") {
        receiver.recoveryState = receiver.hardwareState === "absent" ? "waiting-for-hardware" : "recovering";
        receiver.nextRetryAt = status.nextAttemptAt;
      } else if (status.state === "suppressed") {
        receiver.recoveryState = status.reasonCode === "receiver-startup-grace" ? "recovering" : "cooldown";
        receiver.nextRetryAt = status.nextAttemptAt;
      } else if (status.state === "lockout") {
        receiver.recoveryState = "manual-required";
        receiver.nextRetryAt = status.lockoutUntil;
      } else if (status.reasonCode === "hardware-absent") {
        receiver.recoveryState = "waiting-for-hardware";
        receiver.nextRetryAt = undefined;
      } else if (status.nextAttemptAt) {
        receiver.recoveryState = "cooldown";
        receiver.nextRetryAt = status.nextAttemptAt;
      } else {
        receiver.recoveryState = "manual-required";
        receiver.nextRetryAt = undefined;
      }
      if (previousState !== receiver.recoveryState || previousRetryAt !== receiver.nextRetryAt) changed = true;
    }
    if (changed) this.broadcastSnapshot();
  }

  noteApplicationRecoverySupervisorStatus(status: RecoverySupervisorStatus): void {
    this.applicationRecoveryActive = status.state === "requested" || status.state === "recovering" || status.state === "suppressed";
    if (status.state === "lockout") this.commissioningFaults.add("application-recovery-lockout");
  }

  private restartCommissioningEpoch(): void {
    this.commissioningEpochId = randomUUID();
    this.commissioningStartedAtMonotonicMs = performance.now() + MonitorService.COMMISSIONING_WARMUP_MS;
    this.commissioningStartedAtWallMs = Date.now() + MonitorService.COMMISSIONING_WARMUP_MS;
    this.commissioningFaults.clear();
    this.commissioningLastValidCompletionByTarget.clear();
    this.commissioningValidRevisitsByTarget.clear();
    this.commissioningOnTimeRevisitsByTarget.clear();
    this.commissioningEvidenceFramesDroppedAtStart = this.evidenceFramesDropped;
  }

  private async consumeInterruptionContext(): Promise<EvidenceInterruptionContext | undefined> {
    const source = this.serviceOptions.interruptionContextPath
      ?? process.env.RFMON_LAST_INTERRUPTION_FILE
      ?? "/run/rf-monitor/last-interruption.json";
    try {
      const text = await readFile(source, "utf8");
      if (Buffer.byteLength(text) > 16 * 1024) return undefined;
      const value = JSON.parse(text) as { schemaVersion?: unknown; cause?: unknown; at?: unknown };
      if (value.schemaVersion !== 1 || typeof value.cause !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.cause)) return undefined;
      return { cause: value.cause, ...(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) ? { at: value.at } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.emitServiceError("Restart context could not be read");
      return undefined;
    } finally {
      await unlink(source).catch(() => undefined);
    }
  }

  private async refreshReceiverHealth(): Promise<void> {
    const hardwareState = await detectSdrplayUsb();
    let changed = false;
    for (const receiver of this.receiverStates) {
      if (hardwareState !== "unknown" && receiver.hardwareState !== hardwareState) {
        receiver.hardwareState = hardwareState;
        changed = true;
      }
      if (hardwareState === "absent") {
        if (receiver.streamState !== "stopped" || receiver.recoveryState !== "waiting-for-hardware") changed = true;
        receiver.deviceReady = false;
        receiver.streamReady = false;
        receiver.streamState = "stopped";
        receiver.recoveryState = "waiting-for-hardware";
      } else if (hardwareState === "present" && receiver.recoveryState === "waiting-for-hardware") {
        receiver.recoveryState = "recovering";
        changed = true;
      }
    }
    if (changed) this.broadcastSnapshot();
  }
}
