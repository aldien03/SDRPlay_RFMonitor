import { useCallback, useEffect, useRef, useState } from "react";
import { CLIENT_DATA_LATE_AFTER_MS, decodeSpectrumEnvelope } from "../shared/liveProtocol";
import { liveSubscriptionSignature, MAX_VISIBLE_TARGETS, normalizeLiveSubscription, sameStringSet } from "../shared/liveSubscription";
import {
  MAX_OPERATOR_AFFECTED_TARGETS,
  OPERATOR_ACTION_CODES,
  OPERATOR_REASON_CODES,
  isOperatorSummary,
  resolveOperatorSummary,
  type OperatorActionCode,
  type OperatorSummaryV1,
} from "../shared/operatorSummary";
import type { BaselineDescriptor, ChannelMonitorState, DataDomain, EvidenceArchiveEventPage, EvidenceArchivePage, EvidenceReplayBatch, FocusSession, LiveSubscription, MonitorSnapshot, MonitorStateDelta, OperationalSettings, RecordingDeletionResult, RecoveryOperationHealth, ServiceMessage, SettingsRevision, SignalMetricSample, SpectrumFrame, SyntheticExerciseState } from "../shared/types";

const loadingGeneratedAt = new Date().toISOString();
const emptySnapshot: MonitorSnapshot = {
  generatedAt: loadingGeneratedAt,
  dataDomain: "test",
  identity: {
    schemaVersion: 1,
    serviceBootId: "loading",
    serviceStartedAt: new Date(0).toISOString(),
    nodeVersion: "unknown",
    release: {
      schemaVersion: 1,
      product: "rf-monitor",
      releaseVersion: "loading",
      buildId: "loading",
      serverBuildId: "loading",
      clientBuildId: "loading",
      sourceDigest: "0".repeat(64),
      packageDigest: "0".repeat(64),
      dependencyLockDigest: "0".repeat(64),
      integrity: "runtime-derived",
    },
    protocols: { health: 2, live: 2, evidenceManifest: 2, catalogSchema: 3, operationalSchema: 3 },
    configuration: {
      catalogVersion: "loading",
      configurationHash: "",
      configurationRevision: 0,
      detectorRuleSetId: "rf-relative-mad-v1",
      expectedSampleRateHz: 10_000_000,
    },
  },
  operatorSummary: resolveOperatorSummary({
    generatedAt: loadingGeneratedAt,
    serverBuildId: "loading",
    dataDomain: "unknown",
    monitoring: {
      receiverOnline: true,
      dataFresh: true,
      paused: false,
      alertActive: false,
      recovering: false,
      candidateActive: false,
      detectingActive: false,
      checking: true,
      since: loadingGeneratedAt,
    },
    recording: { state: "stopped" },
    currentHealth: { state: "attention" },
    productionQualification: { state: "failed", ready: false },
    observation: { at: null, coverage: "unknown" },
  }),
  siteName: "Loading configuration",
  displayTimeZone: "UTC",
  timestampStandard: "UTC",
  status: "clear",
  operatorStatus: "Checking",
  monitoringReady: false,
  monitoringIssue: "Connecting to RF Monitor.",
  paused: false,
  mode: "priority-scan",
  coverageGaps: [],
  services: [],
  receivers: [{ id: 0, url: "", connection: "connecting" }],
  scanJobs: [],
  bands: [],
  monitorTargets: [],
  monitorGroups: [],
  monitorFeeds: [],
  sweepCycles: [],
  targetStates: [],
  events: [],
  sessions: [],
  waterfall: [],
  panorama: [],
  evidenceHealthy: false,
  evidencePath: "Loading evidence archive...",
  evidencePathStyle: "posix",
  archiveEntryPathStyle: "posix",
  configuration: {
    explicit: false,
    bandCount: 0,
    bandsFromFile: false,
    detectionFromFile: false,
    revision: 0,
    configurationHash: "",
    catalogVersion: "",
    estimatedRevisitMs: 0,
    scanProfile: "balanced",
    priorityWindowId: "gnss-l1-core",
    maxPriorityGapMs: 10_000,
  },
  storagePolicy: {
    sessionMaxBytes: 0,
    sessionMaxMs: 0,
    retentionMs: 0,
    storageMaxBytes: 0,
    minimumFreeBytes: 0,
    maintenanceIntervalMs: 0,
    deletedSessions: 0,
    deletedExports: 0,
    reclaimedBytes: 0,
    pressure: false,
  },
};

export interface TargetFrameState {
  frame: SpectrumFrame;
  metrics: SignalMetricSample;
  waterfall: SpectrumFrame[];
  monitorState: ChannelMonitorState;
}

export interface SweepFrameState {
  frame: SpectrumFrame;
  metrics: SignalMetricSample;
  waterfall: SpectrumFrame[];
}

export const MAX_CLIENT_WATERFALL_ROWS = 32;
export const HIDDEN_HISTORY_RELEASE_MS = 5 * 60_000;

export type LiveFreshnessInput = "snapshot" | "state-delta" | "heartbeat" | "pong" | "subscription-ack" | "error" | "frame" | "spectrum";

interface FreshnessTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Tracks the age of the canonical control state, independently from transport
 * heartbeats and spectrum traffic. Those messages prove only that bytes are
 * moving; they cannot prove that the latest operator-state transition arrived.
 */
export class CanonicalStateFreshnessWatchdog {
  private handle: unknown;

  constructor(
    private readonly onLate: () => void,
    private readonly timeoutMs = CLIENT_DATA_LATE_AFTER_MS,
    private readonly timers: FreshnessTimers = {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  start(): void {
    this.arm();
  }

  observe(input: LiveFreshnessInput): void {
    if (input === "snapshot" || input === "state-delta") this.arm();
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private arm(): void {
    this.stop();
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      this.onLate();
    }, this.timeoutMs);
  }
}

export function embeddedClientBuildId(root: Pick<Document, "querySelector"> = document): string | undefined {
  return root.querySelector<HTMLMetaElement>('meta[name="rf-monitor-client-build-id"]')?.content.trim() || undefined;
}

export function clientBuildMatches(snapshot: MonitorSnapshot, embeddedBuildId: string | undefined): boolean {
  if (!embeddedBuildId) return true;
  const release = snapshot.identity.release;
  return release.clientBuildId === embeddedBuildId && release.serverBuildId === embeddedBuildId;
}

type CanonicalControlPayload = Pick<MonitorSnapshot, "identity" | "operatorSummary">;

export type CanonicalControlPayloadIssue = "build-mismatch" | "invalid-operator-summary";

export type SequencedCanonicalControlMessage =
  | { type: "snapshot"; controlSequence: number; payload: MonitorSnapshot }
  | { type: "state-delta"; controlSequence: number; payload: MonitorStateDelta };

export interface CanonicalControlCursor {
  serviceBootId: string;
  sequence: number;
}

export type CanonicalControlMessageIssue = CanonicalControlPayloadIssue
  | "invalid-control-sequence"
  | "control-epoch-changed";

export type CanonicalControlAcceptance =
  | { accepted: true; cursor: CanonicalControlCursor; message: SequencedCanonicalControlMessage }
  | { accepted: false; stale: true }
  | { accepted: false; stale: false; issue: CanonicalControlMessageIssue };

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validIsoTimestamp(value: unknown): value is string {
  return nonEmptyBoundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function knownCode(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

/**
 * Runtime validation for the server-owned operator contract. TypeScript types
 * do not protect this WebSocket boundary, so malformed known states and unsafe
 * qualification combinations must fail closed just like unknown state codes.
 */
export function isCanonicalOperatorSummary(value: unknown): value is OperatorSummaryV1 {
  if (!isOperatorSummary(value)) return false;
  const summary = value as OperatorSummaryV1;
  if (!validIsoTimestamp(summary.generatedAt)
    || !nonEmptyBoundedString(summary.serverBuildId, 160)
    || summary.dataMode === "unknown"
    || !validIsoTimestamp(summary.monitoring.since)
    || !knownCode(summary.monitoring.reasonCode, OPERATOR_REASON_CODES)
    || !knownCode(summary.monitoring.actionCode, OPERATOR_ACTION_CODES)
    || !knownCode(summary.recording.reasonCode, OPERATOR_REASON_CODES)
    || !knownCode(summary.recording.actionCode, OPERATOR_ACTION_CODES)
    || !knownCode(summary.currentHealth.reasonCode, OPERATOR_REASON_CODES)
    || !knownCode(summary.currentHealth.actionCode, OPERATOR_ACTION_CODES)
    || !knownCode(summary.productionQualification.reasonCode, OPERATOR_REASON_CODES)
    || !knownCode(summary.productionQualification.actionCode, OPERATOR_ACTION_CODES)) return false;

  const qualificationReady = summary.dataMode === "field"
    && summary.productionQualification.state === "qualified";
  if (summary.productionQualification.ready !== qualificationReady
    || (summary.dataMode === "simulation" && summary.productionQualification.state !== "simulation")
    || (summary.dataMode === "field" && summary.productionQualification.state === "simulation")) return false;

  if (!Array.isArray(summary.affectedTargets)
    || summary.affectedTargets.length > MAX_OPERATOR_AFFECTED_TARGETS) return false;
  const targetIds = new Set<string>();
  for (const target of summary.affectedTargets) {
    const entry = recordValue(target);
    if (!entry
      || !nonEmptyBoundedString(entry.id, 160)
      || !nonEmptyBoundedString(entry.label, 160)
      || (entry.frequencyLabel !== undefined && !nonEmptyBoundedString(entry.frequencyLabel, 80))
      || targetIds.has(entry.id)) return false;
    targetIds.add(entry.id);
  }

  const observation = recordValue(summary.observation);
  if (!observation
    || !["observed", "not-observed", "unknown"].includes(String(observation.coverage))
    || (observation.at !== null && !validIsoTimestamp(observation.at))
    || (observation.ageMs !== null && (typeof observation.ageMs !== "number" || !Number.isFinite(observation.ageMs) || observation.ageMs < 0))
    || (observation.coverage === "observed") !== (observation.at !== null)
    || (observation.targetId !== undefined && !nonEmptyBoundedString(observation.targetId, 160))) return false;

  if (summary.incident !== undefined) {
    const incident = recordValue(summary.incident);
    if (!incident
      || !nonEmptyBoundedString(incident.id, 160)
      || !["active", "recovering"].includes(String(incident.lifecycle))
      || !nonEmptyBoundedString(incident.verdict, 160)
      || !nonEmptyBoundedString(incident.observation, 240)
      || !nonEmptyBoundedString(incident.recommendedAction, 240)
      || !["Low", "Medium"].includes(String(incident.evidenceStrength))
      || !validIsoTimestamp(incident.startedAt)
      || typeof incident.synthetic !== "boolean") return false;
  }
  return true;
}

/** Validate release identity and canonical operator truth before it reaches React. */
export function canonicalControlPayloadIssue(
  value: unknown,
  embeddedBuildId: string | undefined,
): CanonicalControlPayloadIssue | undefined {
  const payload = recordValue(value);
  const identity = recordValue(payload?.identity);
  const release = recordValue(identity?.release);
  if (!payload || !identity || !release || !isCanonicalOperatorSummary(payload.operatorSummary)) {
    return "invalid-operator-summary";
  }
  const clientBuildId = release.clientBuildId;
  const serverBuildId = release.serverBuildId;
  if (!nonEmptyBoundedString(clientBuildId, 160)
    || !nonEmptyBoundedString(serverBuildId, 160)
    || clientBuildId !== serverBuildId
    || payload.operatorSummary.serverBuildId !== serverBuildId
    || (embeddedBuildId !== undefined && (clientBuildId !== embeddedBuildId || serverBuildId !== embeddedBuildId))) {
    return "build-mismatch";
  }
  return undefined;
}

/**
 * Gate every canonical live value before React sees it. A WebSocket is bound
 * to one service boot, and only strictly increasing server sequences can move
 * the complete operator state forward. A reconnect starts with a new cursor
 * and must begin with a full snapshot.
 */
export function acceptCanonicalControlMessage(
  cursor: CanonicalControlCursor | undefined,
  value: unknown,
  embeddedBuildId: string | undefined,
): CanonicalControlAcceptance {
  const message = recordValue(value);
  if (!message || (message.type !== "snapshot" && message.type !== "state-delta")) {
    return { accepted: false, stale: false, issue: "invalid-control-sequence" };
  }
  const controlSequence = message.controlSequence;
  if (!Number.isSafeInteger(controlSequence) || Number(controlSequence) <= 0) {
    return { accepted: false, stale: false, issue: "invalid-control-sequence" };
  }
  const payloadIssue = canonicalControlPayloadIssue(message.payload, embeddedBuildId);
  if (payloadIssue) return { accepted: false, stale: false, issue: payloadIssue };
  const payload = message.payload as MonitorSnapshot | MonitorStateDelta;
  if (message.type === "snapshot") {
    const snapshot = recordValue(message.payload);
    const configuration = recordValue(snapshot?.configuration);
    if (!snapshot || !configuration || !nonEmptyBoundedString(configuration.configurationHash, 160)
      || !Array.isArray(snapshot.bands)
      || !Array.isArray(snapshot.services)
      || !Array.isArray(snapshot.monitorGroups)
      || !Array.isArray(snapshot.monitorFeeds)
      || !Array.isArray(snapshot.waterfall)) {
      return { accepted: false, stale: false, issue: "invalid-control-sequence" };
    }
  }
  const serviceBootId = payload.identity.serviceBootId;
  if (!nonEmptyBoundedString(serviceBootId, 160)) {
    return { accepted: false, stale: false, issue: "invalid-control-sequence" };
  }
  if (!cursor) {
    if (message.type !== "snapshot") {
      return { accepted: false, stale: false, issue: "invalid-control-sequence" };
    }
  } else {
    if (serviceBootId !== cursor.serviceBootId) {
      return { accepted: false, stale: false, issue: "control-epoch-changed" };
    }
    if (Number(controlSequence) <= cursor.sequence) return { accepted: false, stale: true };
  }
  const acceptedMessage = message.type === "snapshot"
    ? { type: "snapshot" as const, controlSequence: Number(controlSequence), payload: payload as MonitorSnapshot }
    : { type: "state-delta" as const, controlSequence: Number(controlSequence), payload: payload as MonitorStateDelta };
  return {
    accepted: true,
    cursor: { serviceBootId, sequence: Number(controlSequence) },
    message: acceptedMessage,
  };
}

function operatorSummaryWithClientFault(
  current: OperatorSummaryV1,
  actionCode: OperatorActionCode,
  nowMs: number,
  buildMismatch: boolean,
): OperatorSummaryV1 {
  const generatedAt = new Date(nowMs).toISOString();
  return {
    ...current,
    generatedAt,
    monitoring: {
      ...current.monitoring,
      state: "data-late",
      reasonCode: "live-data-late",
      actionCode,
      since: current.monitoring.state === "data-late" ? current.monitoring.since : generatedAt,
    },
    observation: {
      ...current.observation,
      ageMs: current.observation.at
        ? Math.max(0, nowMs - Date.parse(current.observation.at))
        : null,
    },
    ...(buildMismatch ? {
      currentHealth: {
        state: "attention" as const,
        reasonCode: "state-code-unknown" as const,
        actionCode: "open-system-health" as const,
      },
      productionQualification: {
        ...current.productionQualification,
        state: "pending" as const,
        ready: false,
        reasonCode: "qualification-pending" as const,
        actionCode: "reload-page" as const,
      },
    } : {}),
  };
}

export function snapshotWithBuildMismatch(current: MonitorSnapshot, nowMs = Date.now()): MonitorSnapshot {
  return {
    ...current,
    operatorSummary: operatorSummaryWithClientFault(current.operatorSummary, "reload-page", nowMs, true),
    operatorStatus: "Checking",
    monitoringReady: false,
    monitoringIssue: "Software updated. Reload this page.",
  };
}

export function snapshotWithInvalidOperatorState(current: MonitorSnapshot, nowMs = Date.now()): MonitorSnapshot {
  return {
    ...snapshotWithBuildMismatch(current, nowMs),
    monitoringIssue: "Live status is invalid. Reload this page.",
  };
}

function canonicalControlIssueMessage(issue: CanonicalControlPayloadIssue): string {
  return issue === "build-mismatch"
    ? "Software updated. Reload this page."
    : "Live status is invalid. Reload this page.";
}

function snapshotWithCanonicalControlIssue(
  current: MonitorSnapshot,
  issue: CanonicalControlPayloadIssue,
  nowMs = Date.now(),
): MonitorSnapshot {
  return issue === "build-mismatch"
    ? snapshotWithBuildMismatch(current, nowMs)
    : snapshotWithInvalidOperatorState(current, nowMs);
}

export interface BaselineRestartOperationResponse {
  operationId: string;
  committed: true;
  state: "complete" | "recovery-required";
  auditDurable: boolean;
  recoveryReason?: string;
}

export interface BaselineApprovalResponse {
  configurationRevision: number;
  baseline: BaselineDescriptor;
}

export interface BaselineRestartResponse {
  configurationRevision: number;
  baseline?: BaselineDescriptor;
  operation?: BaselineRestartOperationResponse;
}

export interface ClearTestDataResponse {
  configurationRevision: number;
  result: {
    domain: "test";
    operationId: string;
    previousDataPresent: boolean;
    committed: true;
    state: "complete" | "recovery-required";
    runtimeState: "active" | "recovery-required";
    cleanupPending: boolean;
    auditDurable: boolean;
    recoveryReason?: string;
  };
}

export interface SoftwareRestartResponse {
  schemaVersion: 1;
  recovery: RecoveryOperationHealth;
  statusUrl?: string;
}

export interface DeleteRecordingsResponse {
  configurationRevision: number;
  result: RecordingDeletionResult;
}

/** Missing or internally inconsistent completion data is never presented as success. */
export function baselineRestartRequiresRecovery(value: BaselineRestartResponse): boolean {
  return value.operation?.committed !== true
    || value.operation.state !== "complete"
    || value.operation.auditDurable !== true;
}

/**
 * Fail closed when the browser stops receiving the live protocol. The server's
 * last incident remains available, but a stale browser must never keep showing
 * a current Normal/Live state.
 */
export function snapshotWithClientDataLate(current: MonitorSnapshot, nowMs = Date.now()): MonitorSnapshot {
  return {
    ...current,
    operatorSummary: operatorSummaryWithClientFault(current.operatorSummary, "reload-live-data", nowMs, false),
    operatorStatus: "Checking",
    monitoringReady: false,
    monitoringIssue: "Live data is late.",
    receivers: current.receivers.map((receiver) => ({
      ...receiver,
      connection: "stale",
      transportState: "reconnecting",
      streamState: "stalled",
      streamReady: false,
      lastFrameAgeMs: receiver.lastFrameAt
        ? Math.max(0, nowMs - Date.parse(receiver.lastFrameAt))
        : receiver.lastFrameAgeMs,
    })),
  };
}

export type CanonicalStateDeltaResult =
  | { accepted: true; snapshot: MonitorSnapshot; dashboardsStatusOnly: boolean }
  | { accepted: false; snapshot: MonitorSnapshot; issue: CanonicalControlPayloadIssue; dashboardsStatusOnly: false };

/**
 * Apply one state delta only after its canonical summary and release identity
 * cross the runtime boundary. Rejected deltas keep the last incident intact.
 */
export function applyCanonicalStateDelta(
  current: MonitorSnapshot,
  value: unknown,
  embeddedBuildId: string | undefined,
  nowMs = Date.now(),
): CanonicalStateDeltaResult {
  const issue = canonicalControlPayloadIssue(value, embeddedBuildId);
  if (issue) {
    return {
      accepted: false,
      snapshot: snapshotWithCanonicalControlIssue(current, issue, nowMs),
      issue,
      dashboardsStatusOnly: false,
    };
  }
  const payload = value as MonitorStateDelta;
  return {
    accepted: true,
    dashboardsStatusOnly: payload.dashboardsStatusOnly === true,
    snapshot: {
      ...current,
      ...payload,
      // The sequence gate makes this complete server-owned truth newer. Never
      // splice an older verdict or incident into it from browser state.
      operatorSummary: payload.operatorSummary,
      currentFrame: payload.dashboardsStatusOnly ? undefined : current.currentFrame,
      currentMetrics: payload.dashboardsStatusOnly ? undefined : payload.currentMetrics,
      waterfall: payload.dashboardsStatusOnly ? [] : current.waterfall,
    },
  };
}

/** Apply an already validated and sequenced control value in queue order. */
export function applyAcceptedCanonicalControl(
  current: MonitorSnapshot,
  message: SequencedCanonicalControlMessage,
): { snapshot: MonitorSnapshot; dashboardsStatusOnly: boolean } {
  if (message.type === "state-delta") {
    const payload = message.payload;
    return {
      dashboardsStatusOnly: payload.dashboardsStatusOnly === true,
      snapshot: {
        ...current,
        ...payload,
        operatorSummary: payload.operatorSummary,
        currentFrame: payload.dashboardsStatusOnly ? undefined : current.currentFrame,
        currentMetrics: payload.dashboardsStatusOnly ? undefined : payload.currentMetrics,
        waterfall: payload.dashboardsStatusOnly ? [] : current.waterfall,
      },
    };
  }
  const latest = message.payload;
  const sameCurrentFrame = latest.currentFrame && current.currentFrame
    && (latest.currentFrame.targetId ?? latest.currentFrame.scanWindowId) === (current.currentFrame.targetId ?? current.currentFrame.scanWindowId);
  const currentFrame = latest.currentFrame?.bins.length
    ? latest.currentFrame
    : sameCurrentFrame
      ? { ...latest.currentFrame!, bins: current.currentFrame!.bins }
      : current.currentFrame;
  const sameConfiguration = latest.configuration.configurationHash === current.configuration.configurationHash;
  return {
    dashboardsStatusOnly: false,
    snapshot: {
      ...latest,
      operatorSummary: latest.operatorSummary,
      bands: sameConfiguration ? current.bands : latest.bands,
      services: sameConfiguration ? current.services : latest.services,
      monitorGroups: sameConfiguration ? current.monitorGroups : latest.monitorGroups,
      monitorFeeds: sameConfiguration ? current.monitorFeeds : latest.monitorFeeds,
      currentFrame,
      currentMetrics: latest.currentMetrics ?? current.currentMetrics,
      waterfall: latest.waterfall.length ? latest.waterfall : current.waterfall,
    },
  };
}

export function appendWaterfallFrame(history: SpectrumFrame[], frame: SpectrumFrame): SpectrumFrame[] {
  const withoutReplay = history.filter((candidate) => candidate.id !== frame.id);
  return [...withoutReplay.slice(-(MAX_CLIENT_WATERFALL_ROWS - 1)), frame];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly fields?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
  }
}

function evidenceColor(value: number): string {
  const level = Math.max(0, Math.min(1, (value - 18) / 125));
  if (level < 0.28) return `rgb(0, ${Math.round(25 + level * 175)}, ${Math.round(92 + level * 360)})`;
  if (level < 0.52) return `rgb(0, ${Math.round(120 + level * 230)}, ${Math.round(190 - level * 240)})`;
  if (level < 0.76) return `rgb(${Math.round(110 + level * 185)}, ${Math.round(225 - level * 35)}, 0)`;
  return `rgb(${Math.round(230 + level * 25)}, ${Math.round(210 - level * 190)}, 0)`;
}

function fitCanvasText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let end = value.length;
  while (end > 1 && context.measureText(`${value.slice(0, end)}...`).width > maxWidth) end -= 1;
  return `${value.slice(0, end)}...`;
}

function drawEvidencePlot(context: CanvasRenderingContext2D, snapshot: MonitorSnapshot, top: number, width: number, height: number): void {
  const frame = snapshot.currentFrame;
  const metrics = snapshot.currentMetrics;
  context.fillStyle = "#ffffff";
  context.fillRect(0, top, width, height);
  context.strokeStyle = "#dbe1e7";
  context.lineWidth = 1;
  for (let row = 0; row <= 4; row += 1) {
    const y = top + (height * row) / 4;
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
  }
  for (let column = 0; column <= 6; column += 1) {
    const x = (width * column) / 6;
    context.beginPath();
    context.moveTo(x + 0.5, top);
    context.lineTo(x + 0.5, top + height);
    context.stroke();
  }
  if (!frame?.bins.length) {
    context.fillStyle = "#5d6b78";
    context.font = "600 20px Arial, sans-serif";
    context.textAlign = "center";
    context.fillText("No scan was available for this snapshot", width / 2, top + height / 2);
    context.textAlign = "left";
    return;
  }
  const bottom = top + height - 10;
  const xFor = (index: number) => (index / Math.max(1, frame.bins.length - 1)) * width;
  const yFor = (value: number) => bottom - (Math.max(0, Math.min(255, value)) / 255) * (height - 20);
  context.beginPath();
  frame.bins.forEach((value, index) => index === 0 ? context.moveTo(xFor(index), yFor(value)) : context.lineTo(xFor(index), yFor(value)));
  context.strokeStyle = "#0068b8";
  context.lineWidth = 2;
  context.stroke();
  if (metrics) {
    context.setLineDash([8, 7]);
    context.beginPath();
    context.moveTo(0, yFor(metrics.baselineLevel));
    context.lineTo(width, yFor(metrics.baselineLevel));
    context.strokeStyle = "#16883a";
    context.lineWidth = 1.5;
    context.stroke();
    context.setLineDash([]);
  }
}

function drawEvidenceWaterfall(context: CanvasRenderingContext2D, snapshot: MonitorSnapshot, top: number, width: number, height: number): void {
  context.fillStyle = "#06285d";
  context.fillRect(0, top, width, height);
  const frames = [...snapshot.waterfall].reverse();
  if (!frames.length) return;
  const rowHeight = Math.max(1, height / Math.max(24, frames.length));
  frames.forEach((frame, row) => {
    const visibleBins = Math.min(width, frame.bins.length);
    for (let column = 0; column < visibleBins; column += 1) {
      const sourceIndex = Math.min(frame.bins.length - 1, Math.floor((column / visibleBins) * frame.bins.length));
      context.fillStyle = evidenceColor(frame.bins[sourceIndex]);
      context.fillRect((column / visibleBins) * width, top + row * rowHeight, width / visibleBins + 1, rowHeight + 0.5);
    }
  });
}

async function createEvidenceScreenshot(snapshot: MonitorSnapshot, eventId: string): Promise<Blob | null> {
  const width = 1_200;
  const headerHeight = 126;
  const spectrumHeight = 360;
  const gap = 18;
  const waterfallHeight = 250;
  const footerHeight = 54;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = headerHeight + spectrumHeight + gap + waterfallHeight + footerHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#142536";
  context.font = "bold 28px Arial, sans-serif";
  context.fillText("RF Monitor incident evidence", 24, 38);
  context.font = "17px Arial, sans-serif";
  context.fillText(fitCanvasText(context, `${snapshot.siteName} | ${eventId} | ${new Date().toISOString()}`, width - 48), 24, 70);
  const frame = snapshot.currentFrame;
  const frameDescription = frame
    ? `${(frame.startHz / 1_000_000).toFixed(3)}-${(frame.endHz / 1_000_000).toFixed(3)} MHz | ${frame.source} | ${frame.calibrated ? "calibrated" : "uncalibrated relative bins"}`
    : "No scan available";
  context.fillText(fitCanvasText(context, `${frameDescription} | config ${snapshot.configuration.configurationHash.slice(0, 16)}`, width - 48), 24, 100);
  drawEvidencePlot(context, snapshot, headerHeight, width, spectrumHeight);
  drawEvidenceWaterfall(context, snapshot, headerHeight + spectrumHeight + gap, width, waterfallHeight);
  context.fillStyle = "#142536";
  context.font = "16px Arial, sans-serif";
  context.fillText("Spectrum above. Signal history below, newest first. Full RF data is included with the incident.", 24, canvas.height - 20);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; fields?: Record<string, string> };
    throw new ApiError(payload.error ?? response.statusText, response.status, payload.fields);
  }
  return response.json() as Promise<T>;
}

async function downloadArchive(path: string, fallbackFilename: string, _errorMessage: string): Promise<void> {
  const link = document.createElement("a");
  link.href = path;
  link.download = fallbackFilename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

interface ExportJobResponse {
  id: string;
  state: "queued" | "running" | "ready" | "failed";
  error?: string;
  statusUrl: string;
  downloadUrl: string;
  parts?: Array<{ number: number; sizeBytes: number; sha256: string; downloadUrl: string }>;
}

async function queueExportDownload(body: object, fallbackFilename: string): Promise<void> {
  let job = await request<ExportJobResponse>("/api/exports", { method: "POST", body: JSON.stringify(body) });
  const deadline = Date.now() + 10 * 60_000;
  while (job.state === "queued" || job.state === "running") {
    if (Date.now() >= deadline) throw new Error("Evidence export is still running. Try again from Evidence History.");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    job = await request<ExportJobResponse>(job.statusUrl);
  }
  if (job.state !== "ready") throw new Error(job.error ?? "Evidence export failed");
  const parts = job.parts?.length ? job.parts : [{ number: 1, downloadUrl: job.downloadUrl }];
  for (const part of parts) {
    const filename = parts.length === 1
      ? fallbackFilename
      : fallbackFilename.replace(/\.zip$/i, `-part-${String(part.number).padStart(3, "0")}.zip`);
    await downloadArchive(part.downloadUrl, filename, "Evidence export failed");
  }
}

export function useMonitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(emptySnapshot);
  const [targetFrames, setTargetFrames] = useState<Record<string, TargetFrameState>>({});
  const [sweepFrames, setSweepFrames] = useState<Record<string, SweepFrameState>>({});
  const targetFramesRef = useRef<Record<string, TargetFrameState>>({});
  const [error, setError] = useState<string>();
  const [reloadRequired, setReloadRequired] = useState(false);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const freshnessWatchdog = useRef<CanonicalStateFreshnessWatchdog | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const stopped = useRef(false);
  const reloadRequiredRef = useRef(false);
  const controlCursor = useRef<CanonicalControlCursor | undefined>(undefined);
  const pendingControls = useRef<SequencedCanonicalControlMessage[]>([]);
  const controlFlushScheduled = useRef(false);
  const reconnectAttempt = useRef(0);
  const hiddenReleaseTimer = useRef<number | undefined>(undefined);
  const engineerStream = useRef(false);
  const visibleTargetIds = useRef<string[]>([]);
  const detailTargetIds = useRef<string[]>([]);
  const visibleFeedIds = useRef<string[]>([]);
  const detailFeedIds = useRef<string[]>([]);
  const lastSubscriptionSignature = useRef<string | undefined>(undefined);
  useEffect(() => { targetFramesRef.current = targetFrames; }, [targetFrames]);

  const sendSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const subscription = normalizeLiveSubscription({
      type: "subscribe",
      protocolVersion: 2,
      rateHz: document.hidden ? 0.2 : engineerStream.current ? 4 : 2,
      engineer: engineerStream.current,
      visibleTargetIds: visibleTargetIds.current,
      detailTargetIds: detailTargetIds.current,
      visibleFeedIds: visibleFeedIds.current,
      detailFeedIds: detailFeedIds.current,
    });
    if (!subscription) return;
    const signature = liveSubscriptionSignature(subscription);
    if (lastSubscriptionSignature.current === signature) return;
    lastSubscriptionSignature.current = signature;
    socket.send(JSON.stringify(subscription));
  }, []);

  const connect = useCallback(() => {
    try {
      if (stopped.current || reloadRequiredRef.current) return;
      freshnessWatchdog.current?.stop();
      const watchdog = new CanonicalStateFreshnessWatchdog(
        () => {
          setSnapshot((current) => snapshotWithClientDataLate(current));
          setError("Live data is late. Reconnecting.");
        },
        CLIENT_DATA_LATE_AFTER_MS,
        {
          setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimeout: (handle) => window.clearTimeout(handle as number),
        },
      );
      freshnessWatchdog.current = watchdog;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/live`);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      controlCursor.current = undefined;
      pendingControls.current = [];
      controlFlushScheduled.current = false;
      lastSubscriptionSignature.current = undefined;
      socket.onopen = () => {
        reconnectAttempt.current = 0;
        watchdog.start();
        sendSubscription();
      };
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          watchdog.observe("spectrum");
          try {
            const envelope = decodeSpectrumEnvelope(event.data);
            const frame = { ...envelope.frame, bins: envelope.bins };
            if (envelope.feedId) {
              const feedId = envelope.feedId;
              setSweepFrames((current) => ({
                ...current,
                [feedId]: {
                  frame,
                  metrics: envelope.metrics,
                  waterfall: appendWaterfallFrame(current[feedId]?.waterfall ?? [], frame),
                },
              }));
              return;
            }
            const targetId = frame.targetId ?? frame.scanWindowId ?? frame.bandId;
            const monitorState = envelope.targetState ?? targetFramesRef.current[targetId]?.monitorState ?? {
              targetId,
              lifecycle: "detecting" as const,
              candidateCount: 0,
              clearCount: 0,
              requiredCount: 10,
              lastObservedAt: frame.timestamp,
              observationDisposition: "unknown" as const,
            };
            setTargetFrames((current) => ({
              ...current,
              [targetId]: {
                frame,
                metrics: envelope.metrics,
                monitorState,
                waterfall: current[targetId]?.frame.syntheticExercise && !frame.syntheticExercise
                  ? [frame]
                  : appendWaterfallFrame(current[targetId]?.waterfall ?? [], frame),
              },
            }));
            setSnapshot((current) => ({
              ...current,
              generatedAt: frame.timestamp,
              lastUpdatedAt: frame.timestamp,
              currentFrame: frame,
              currentMetrics: envelope.metrics,
              activeEvent: envelope.event ?? (current.activeEvent?.targetId === targetId && monitorState.lifecycle === "clear" ? undefined : current.activeEvent),
              events: envelope.event
                ? [envelope.event, ...current.events.filter((item) => item.id !== envelope.event?.id)].slice(0, 10)
                : current.events,
              waterfall: [...current.waterfall.filter((item) => item.startHz === frame.startHz && item.endHz === frame.endHz).slice(-31), frame],
              receivers: current.receivers.map((receiver) => receiver.id === frame.receiver ? {
                ...receiver,
                connection: frame.source === "simulation" ? "simulated" : "live",
                hardwareState: frame.source === "simulation" ? receiver.hardwareState : "present",
                transportState: "connected",
                streamState: "live",
                recoveryState: "idle",
                streamReady: true,
                lastFrameAt: frame.timestamp,
                lastFrameAgeMs: 0,
              } : receiver),
            }));
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
          return;
        }
        let message: ServiceMessage;
        try {
          const parsed = JSON.parse(event.data) as unknown;
          const parsedRecord = recordValue(parsed);
          if (!parsedRecord || typeof parsedRecord.type !== "string") throw new Error("Invalid live control message");
          message = parsed as ServiceMessage;
        } catch {
          setError("Live control data is invalid. Reload this page.");
          return;
        }
        if (message.type === "snapshot" || message.type === "state-delta") {
          const acceptance = acceptCanonicalControlMessage(controlCursor.current, message, embeddedClientBuildId());
          if (!acceptance.accepted) {
            if (acceptance.stale) return;
            reloadRequiredRef.current = true;
            setReloadRequired(true);
            const payloadIssue = acceptance.issue === "build-mismatch" ? "build-mismatch" : "invalid-operator-summary";
            setError(canonicalControlIssueMessage(payloadIssue));
            setSnapshot((current) => snapshotWithCanonicalControlIssue(current, payloadIssue));
            socket.close(1000, acceptance.issue === "build-mismatch" ? "Client build mismatch" : "Invalid live control order");
            return;
          }
          controlCursor.current = acceptance.cursor;
          if (pendingControls.current.length >= 64) {
            reloadRequiredRef.current = true;
            setReloadRequired(true);
            setError("Live status is invalid. Reload this page.");
            setSnapshot((current) => snapshotWithInvalidOperatorState(current));
            socket.close(1013, "Live control queue exceeded its bound");
            return;
          }
          pendingControls.current.push(acceptance.message);
          watchdog.observe(message.type);
          setError(undefined);
          if (!controlFlushScheduled.current) {
            controlFlushScheduled.current = true;
            queueMicrotask(() => {
              controlFlushScheduled.current = false;
              if (socketRef.current !== socket || stopped.current) {
                pendingControls.current = [];
                return;
              }
              const batch = pendingControls.current.splice(0);
              if (!batch.length) return;
              if (batch.some((control) => control.type === "state-delta" && control.payload.dashboardsStatusOnly)) {
                setTargetFrames({});
                setSweepFrames({});
              }
              setSnapshot((current) => batch.reduce(
                (latest, control) => applyAcceptedCanonicalControl(latest, control).snapshot,
                current,
              ));
            });
          }
        }
        if (message.type === "error") setError(message.payload.message);
      };
      socket.onerror = () => {
        setSnapshot((current) => snapshotWithClientDataLate(current));
        setError("Live data is late. Reconnecting.");
      };
      socket.onclose = () => {
        watchdog.stop();
        if (freshnessWatchdog.current === watchdog) freshnessWatchdog.current = undefined;
        lastSubscriptionSignature.current = undefined;
        if (stopped.current || reloadRequiredRef.current) return;
        setSnapshot((current) => snapshotWithClientDataLate(current));
        setError("Live data is late. Reconnecting.");
        const delay = Math.min(15_000, 1_000 * (2 ** Math.min(4, reconnectAttempt.current++))) + Math.round(Math.random() * 500);
        reconnectTimer.current = window.setTimeout(() => void connect(), delay);
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSnapshot((current) => snapshotWithClientDataLate(current));
      if (!stopped.current) reconnectTimer.current = window.setTimeout(() => void connect(), 2_000);
    }
  }, [sendSubscription]);

  useEffect(() => {
    stopped.current = false;
    void request<MonitorSnapshot>("/api/snapshot")
      .then((next) => {
        const payloadIssue = canonicalControlPayloadIssue(next, embeddedClientBuildId());
        if (payloadIssue) {
          reloadRequiredRef.current = true;
          setReloadRequired(true);
          setError(canonicalControlIssueMessage(payloadIssue));
          setSnapshot((current) => snapshotWithCanonicalControlIssue(current, payloadIssue));
          return;
        }
        setError(undefined);
        setSnapshot(next);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { if (!reloadRequiredRef.current) connect(); });
    return () => {
      stopped.current = true;
      socketRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (hiddenReleaseTimer.current) clearTimeout(hiddenReleaseTimer.current);
      freshnessWatchdog.current?.stop();
      freshnessWatchdog.current = undefined;
      pendingControls.current = [];
      controlFlushScheduled.current = false;
      controlCursor.current = undefined;
    };
  }, [connect]);

  useEffect(() => {
    const update = () => {
      if (hiddenReleaseTimer.current) clearTimeout(hiddenReleaseTimer.current);
      hiddenReleaseTimer.current = undefined;
      if (document.hidden) {
        hiddenReleaseTimer.current = window.setTimeout(() => {
          hiddenReleaseTimer.current = undefined;
          setTargetFrames({});
          setSweepFrames({});
          setSnapshot((current) => ({ ...current, currentFrame: undefined, currentMetrics: undefined, waterfall: [] }));
        }, HIDDEN_HISTORY_RELEASE_MS);
      }
      sendSubscription();
    };
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      if (hiddenReleaseTimer.current) clearTimeout(hiddenReleaseTimer.current);
      hiddenReleaseTimer.current = undefined;
    };
  }, [sendSubscription]);

  const setEngineerStream = useCallback((enabled: boolean) => {
    engineerStream.current = enabled;
    sendSubscription();
  }, [sendSubscription]);

  const setVisibleTargets = useCallback((
    targetIds: string[],
    selectedTargetIds: string[],
    feedIds: string[] = [],
    selectedFeedIds: string[] = [],
  ) => {
    const nextVisible = [...new Set(targetIds)].slice(0, MAX_VISIBLE_TARGETS);
    const nextDetails = [...new Set(selectedTargetIds)]
      .filter((targetId) => nextVisible.includes(targetId))
      .slice(0, 9);
    const nextVisibleFeeds = [...new Set(feedIds)].slice(0, MAX_VISIBLE_TARGETS);
    const nextDetailFeeds = [...new Set(selectedFeedIds)]
      .filter((feedId) => nextVisibleFeeds.includes(feedId))
      .slice(0, 9);
    if (sameStringSet(nextVisible, visibleTargetIds.current)
      && sameStringSet(nextDetails, detailTargetIds.current)
      && sameStringSet(nextVisibleFeeds, visibleFeedIds.current)
      && sameStringSet(nextDetailFeeds, detailFeedIds.current)) return;
    visibleTargetIds.current = nextVisible;
    detailTargetIds.current = nextDetails;
    visibleFeedIds.current = nextVisibleFeeds;
    detailFeedIds.current = nextDetailFeeds;
    setTargetFrames((current) => Object.fromEntries(Object.entries(current).filter(([targetId]) => nextVisible.includes(targetId))));
    setSweepFrames((current) => Object.fromEntries(Object.entries(current).filter(([feedId]) => nextVisibleFeeds.includes(feedId))));
    setSnapshot((current) => {
      const currentTargetId = current.currentFrame?.targetId ?? current.currentFrame?.scanWindowId ?? current.currentFrame?.bandId;
      if (currentTargetId && nextVisible.includes(currentTargetId)) return current;
      return { ...current, currentFrame: undefined, currentMetrics: undefined, waterfall: [] };
    });
    sendSubscription();
  }, [sendSubscription]);

  const pause = useCallback(async (paused: boolean) => {
    setSnapshot((current) => ({ ...current, paused }));
    const next = await request<MonitorSnapshot>("/api/monitor/pause", {
      method: "POST",
      body: JSON.stringify({ paused }),
    });
    setSnapshot(next);
  }, []);

  const acknowledge = useCallback(async (eventId: string) => {
    await request(`/api/events/${eventId}/acknowledge`, { method: "POST", body: "{}" });
  }, []);

  const addNote = useCallback(async (eventId: string, text: string) => {
    await request(`/api/events/${eventId}/notes`, { method: "POST", body: JSON.stringify({ text }) });
  }, []);

  const exportIncident = useCallback(async (eventId: string, sessionId?: string) => {
    await queueExportDownload({ kind: "incident", eventId, sessionId }, `rf-incident-${eventId}.zip`);
  }, []);

  const getEvidenceArchive = useCallback((offset = 0, limit = 20) => (
    request<EvidenceArchivePage>(`/api/evidence/archive?offset=${offset}&limit=${limit}`)
  ), []);

  const getEvidenceSessionEvents = useCallback((sessionId: string, offset = 0, limit = 20) => (
    request<EvidenceArchiveEventPage>(`/api/evidence/sessions/${encodeURIComponent(sessionId)}/events?offset=${offset}&limit=${limit}`)
  ), []);

  const getEvidenceReplayBatch = useCallback((sessionId: string, cursor?: string, limit = 12) => {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (cursor) parameters.set("cursor", cursor);
    return request<EvidenceReplayBatch>(`/api/evidence/sessions/${encodeURIComponent(sessionId)}/replay?${parameters}`);
  }, []);

  const exportSession = useCallback(async (sessionId: string) => {
    await queueExportDownload({ kind: "session", sessionId }, `${sessionId}.zip`);
  }, []);

  const captureScreenshot = useCallback(async (eventId: string) => {
    const blob = await createEvidenceScreenshot(snapshot, eventId);
    if (!blob) return;
    const response = await fetch(`/api/events/${eventId}/screenshots`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
      },
      body: blob,
    });
    if (!response.ok) throw new Error("Evidence screenshot could not be saved");
  }, [snapshot]);

  const getSettings = useCallback(() => request<SettingsRevision>("/api/settings"), []);

  const unlockSettings = useCallback((password: string) => request<SettingsRevision>("/api/admin/unlock", {
    method: "POST",
    body: JSON.stringify({ password }),
  }), []);

  const lockSettings = useCallback(() => request<{ unlocked: false }>("/api/admin/lock", { method: "POST", body: "{}" }), []);

  const applySettings = useCallback((settings: OperationalSettings, expectedRevision: number) => request<SettingsRevision>("/api/settings", {
    method: "PUT",
    headers: { "x-rf-monitor-csrf": "settings-v1" },
    body: JSON.stringify({ settings, expectedRevision }),
  }), []);

  const baselineRequest = useCallback(<T,>(action: "approve" | "restart", baseline: BaselineDescriptor, expectedConfigurationRevision: number) => (
    request<T>(`/api/baselines/${encodeURIComponent(baseline.targetId)}/${action}`, {
      method: "POST",
      headers: { "x-rf-monitor-csrf": "settings-v1" },
      body: JSON.stringify({
        expectedConfigurationRevision,
        expectedFingerprintId: baseline.fingerprintId,
        expectedGeneration: Number(baseline.learningGenerationId),
      }),
    })
  ), []);

  const clearTestData = useCallback((expectedConfigurationRevision: number) => request<ClearTestDataResponse>("/api/test-data/clear", {
    method: "POST",
    headers: { "x-rf-monitor-csrf": "settings-v1" },
    body: JSON.stringify({ expectedConfigurationRevision, confirmation: "CLEAR TEST DATA" }),
  }), []);

  const deleteRecordings = useCallback((expectedConfigurationRevision: number, dataDomain: DataDomain) => request<DeleteRecordingsResponse>("/api/recordings/delete", {
    method: "POST",
    headers: { "x-rf-monitor-csrf": "settings-v1" },
    body: JSON.stringify({ expectedConfigurationRevision, dataDomain, confirmation: "DELETE RECORDINGS" }),
  }), []);

  const restartSoftware = useCallback((expectedConfigurationRevision: number) => request<SoftwareRestartResponse>("/api/software/restart", {
    method: "POST",
    headers: { "x-rf-monitor-csrf": "settings-v1" },
    body: JSON.stringify({ expectedConfigurationRevision, confirmation: "RESTART SOFTWARE" }),
  }), []);

  const getSoftwareRestartStatus = useCallback(() => request<RecoveryOperationHealth>("/api/software/restart/status"), []);

  const startFocus = useCallback((bandId: string, centerHz: number | undefined, durationMs: number) => request<FocusSession>("/api/monitor/focus", {
    method: "POST",
    body: JSON.stringify({ bandId, centerHz, durationMs }),
  }), []);

  const stopFocus = useCallback(() => request<MonitorSnapshot>("/api/monitor/focus", { method: "DELETE", body: "{}" }), []);

  const startSyntheticExercise = useCallback(async (scenarioId: string) => {
    const result = await request<{ playback: SyntheticExerciseState }>("/api/validation/playback", {
      method: "POST",
      body: JSON.stringify({ scenarioId }),
    });
    setSnapshot((current) => ({ ...current, syntheticExercise: result.playback }));
    return result.playback;
  }, []);

  const stopSyntheticExercise = useCallback(async () => {
    const result = await request<{ playback: SyntheticExerciseState | null }>("/api/validation/playback", {
      method: "DELETE",
      body: "{}",
    });
    setSnapshot((current) => ({ ...current, syntheticExercise: result.playback ?? undefined }));
    return result.playback ?? undefined;
  }, []);

  const retryReceiver = useCallback(async () => {
    const next = await request<{ snapshot?: MonitorSnapshot }>("/api/receiver/retry", { method: "POST", body: "{}" });
    if (next.snapshot) setSnapshot(next.snapshot);
  }, []);

  return {
    snapshot,
    targetFrames,
    sweepFrames,
    error,
    reloadRequired,
    pause,
    acknowledge,
    addNote,
    captureScreenshot,
    exportIncident,
    getEvidenceArchive,
    getEvidenceSessionEvents,
    getEvidenceReplayBatch,
    exportSession,
    getSettings,
    unlockSettings,
    lockSettings,
    applySettings,
    approveBaseline: (baseline: BaselineDescriptor, revision: number) => baselineRequest<BaselineApprovalResponse>("approve", baseline, revision),
    restartBaseline: (baseline: BaselineDescriptor, revision: number) => baselineRequest<BaselineRestartResponse>("restart", baseline, revision),
    clearTestData,
    deleteRecordings,
    restartSoftware,
    getSoftwareRestartStatus,
    startFocus,
    stopFocus,
    startSyntheticExercise,
    stopSyntheticExercise,
    retryReceiver,
    setEngineerStream,
    setVisibleTargets,
  };
}
