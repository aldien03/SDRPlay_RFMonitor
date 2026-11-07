import { createServer, type IncomingMessage } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { estimateRevisitMs } from "../shared/bands";
import { liveSubscriptionSignature, normalizeLiveSubscription, type NormalizedLiveSubscription } from "../shared/liveSubscription";
import { evaluateSettingsFeasibility, SettingsValidationError } from "../shared/settings";
import type { CurrentMonitoringHealth, DetectionEvent, DiagnosticSummaryState, HealthSnapshotV2, LiveSubscription, MonitorSnapshot, MonitorStateDelta, OperationalSettings, ProductionQualification, ResourceHealth, ServiceMessage, SettingsRevision, StreamingHealth } from "../shared/types";
import { encodeSpectrumEnvelope, LIVE_HEARTBEAT_INTERVAL_MS } from "../shared/liveProtocol";
import { AdminAuth, AdminAuthenticationError } from "./adminAuth";
import { loadConfig, withOperationalSettings } from "./config";
import { BaselineApprovalUnavailableError, CommittedBaselineRestartRecoveryError, MonitorService } from "./monitorService";
import { ConcurrentRequestGate, OutboundTrafficMeter, ResourceBudgetController, TokenBucket } from "./resourceBudget";
import { HostMemoryController } from "./hostMemory";
import { RevisionConflictError, SettingsStore } from "./settingsStore";
import { BaselineConflictError, BaselineNotReviewableError } from "./baselineStore";
import { ExportJobQueue, ExportProtectedBytesError, ExportQueueFullError } from "./exportJobQueue";
import { EvidenceExportSourceError, WRITER_ORDINARY_MAX_BYTES, WRITER_ORDINARY_MAX_ITEMS } from "./evidenceStore";
import { EvidencePlaybackError, EvidencePlaybackReader } from "./evidencePlayback";
import {
  MAX_SCREENSHOT_PNG_BYTES,
  ScreenshotBodyGate,
  ScreenshotPngError,
  type ScreenshotAdmissionLease,
} from "./screenshotAdmission";
import { DiagnosticsCollector, type DiagnosticsRuntimeSample } from "./diagnosticsCollector";
import { ProductionQualificationStore, productionReadyForHealth } from "./productionQualification";
import { applyAuthoritativeOperatorRuntime } from "./operatorSnapshot";
import {
  publishAuditedApplicationRestartRequest,
  publishReceiverRecoveryRequest,
  readRecoverySupervisorStatus,
  recoveryOperationState,
  type RecoveryOperationState,
  type RecoveryStatusReadResult,
} from "./recoveryRequest";
import { LatestLiveControlQueue } from "./liveControlQueue";
import {
  listSyntheticQualificationScenarios,
  runSyntheticQualificationScenario,
} from "./syntheticQualificationRunner";
import type { SyntheticRunMode } from "../shared/syntheticValidation";
import { detectorQualificationPlan } from "../shared/detectorQualification";
import { sha256Canonical } from "./syntheticValidation";
import { StabilityIncidentStore } from "./stabilityIncidentStore";
import { createShutdownCoordinator, guardUpgradeSocket, guardWebSocket } from "./processSafety";

const streamingStartedAt = Date.now();
const streamingCounters = {
  outboundBytes: 0,
  spectrumMessages: 0,
  coalescedFrames: 0,
  slowClientDrops: 0,
  budgetDrops: 0,
  duplicateSubscriptions: 0,
  rejectedClients: 0,
  maxBufferedBytes: 0,
};
const outboundTraffic = new OutboundTrafficMeter();
const globalLiveBudget = new TokenBucket(1024 * 1024, 2 * 1024 * 1024);
const resourceBudget = new ResourceBudgetController();
const hostMemoryController = new HostMemoryController();
const MAX_LIVE_CLIENTS = 8;
const MAX_NORMAL_HTTP_REQUESTS = 64;
const normalHttpGate = new ConcurrentRequestGate(MAX_NORMAL_HTTP_REQUESTS);
const CLIENT_PRESSURE_BYTES = 64 * 1024;
const CLIENT_CLOSE_BYTES = 256 * 1024;
const MAX_CONTROL_STATE_BYTES = 128 * 1024;
const MAX_SYNTHETIC_VALIDATION_RESPONSE_BYTES = 64 * 1024;
const screenshotBodyGate = new ScreenshotBodyGate();
let liveControlSequence = 0;
let liveClientSequence = 0;

function nextLiveControlSequence(): number {
  if (liveControlSequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Live control sequence exhausted");
  }
  liveControlSequence += 1;
  return liveControlSequence;
}
const receiverRecoveryRequest = process.env.RF_MONITOR_RECOVERY_REQUEST ?? "/run/rf-monitor/recover-sdrconnect";
const receiverRecoveryStatusPath = process.env.RFMON_RECOVERY_STATUS_FILE ?? "/run/rf-monitor-recovery/status.json";
const applicationRestartRequest = process.env.RF_MONITOR_APPLICATION_RESTART_REQUEST ?? "/run/rf-monitor/restart-application";
const applicationRecoveryStatusPath = process.env.RFMON_APPLICATION_RECOVERY_STATUS_FILE ?? "/run/rf-monitor-application-recovery/status.json";
let lastRecoveryRequestAt = 0;
let lastApplicationRestartRequestAt = 0;
let receiverRecoveryStatus: RecoveryStatusReadResult = { availability: "unavailable", reasonCode: "missing" };
let applicationRecoveryStatus: RecoveryStatusReadResult = { availability: "unavailable", reasonCode: "missing" };
let recoveryStatusRefreshInFlight: Promise<void> | undefined;
let syntheticValidationRunActive = false;
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();
const eventLoopSamples: Array<{ at: number; p50Ms: number; p99Ms: number }> = [];
let resourceHealthCache: { at: number; value: ResourceHealth } | undefined;
let eventLoopSampleTimer: NodeJS.Timeout;

let config = await loadConfig();
const stabilityIncidents = await StabilityIncidentStore.open(path.join(config.dataRoots.field.root, "stability-incidents.jsonl"));
const settingsStore = await SettingsStore.create({
  settings: config.operationalSettings,
  catalog: config.bandCatalog,
  operationalPath: config.settingsPaths.operational,
  auditPath: config.settingsPaths.audit,
  revisionsPath: config.settingsPaths.revisions,
});
const adminAuth = await AdminAuth.load(config.settingsPaths.admin, config.adminSessionMs);
const monitor = new MonitorService(config);
const evidencePlayback = new EvidencePlaybackReader(config.storageRoot, config.dataDomain);
eventLoopSampleTimer = setInterval(() => {
  const at = Date.now();
  const p50Ms = Number.isFinite(eventLoopHistogram.percentile(50)) ? eventLoopHistogram.percentile(50) / 1_000_000 : 0;
  const p99Ms = Number.isFinite(eventLoopHistogram.percentile(99)) ? eventLoopHistogram.percentile(99) / 1_000_000 : 0;
  eventLoopSamples.push({ at, p50Ms, p99Ms });
  while (eventLoopSamples[0] && at - eventLoopSamples[0].at > 60_000) eventLoopSamples.shift();
  eventLoopHistogram.reset();
  resourceHealthCache = undefined;
  currentResourceHealth();
}, 10_000);
eventLoopSampleTimer.unref();
const productionQualificationStore = await ProductionQualificationStore.open(path.join(
  config.dataRoots[config.dataDomain].root,
  "qualification",
  "qualification-v1.json",
), {
  approvalRecordPath: process.env.RFMON_QUALIFICATION_APPROVAL_FILE
    ?? "/etc/rf-monitor/qualification-approval-v1.json",
});
type ExportRequest =
  | { kind: "incident"; eventId: string; sessionId?: string }
  | { kind: "session"; sessionId: string };
const protectedExportByteLimit = () => Math.max(
  1,
  Math.min(config.retentionPolicy.storageMaxBytes - 1, Math.floor(config.retentionPolicy.storageMaxBytes / 4)),
);
const exportQueue = new ExportJobQueue<ExportRequest>({
  builder: async (request, context) => {
    const outputPath = request.kind === "incident"
      ? await monitor.exportIncident(request.eventId, request.sessionId, context.jobId)
      : await monitor.exportSession(request.sessionId, context.jobId);
    if (!outputPath) throw new Error(request.kind === "incident" ? "Incident evidence was not found" : "Evidence session was not found");
    return outputPath;
  },
  canStart: () => currentResourceHealth().admitExports !== false,
  onOutputsReady: (paths) => monitor.protectExportArtifacts(paths, true),
  onOutputsReleased: (paths) => monitor.protectExportArtifacts(paths, false),
  onOutputsDiscarded: (paths) => monitor.discardExportArtifacts(paths),
  maxProtectedOutputBytes: protectedExportByteLimit,
});
const diagnosticsCollector = new DiagnosticsCollector({ runtimeProvider: diagnosticsRuntimeSample });
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use((_request, response, next) => {
  response.setHeader("X-RF-Monitor-Build-ID", config.runtimeIdentity.release.buildId);
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use((request, response, next) => {
  const startedBytes = request.socket.bytesWritten;
  let recorded = false;
  const recordResponseBytes = () => {
    if (recorded) return;
    recorded = true;
    const declaredLength = Number(response.getHeader("content-length"));
    const bytes = response.writableFinished && request.method !== "HEAD" && Number.isFinite(declaredLength) && declaredLength >= 0
      ? declaredLength
      : Math.max(0, request.socket.bytesWritten - startedBytes);
    outboundTraffic.addHttp(bytes);
  };
  response.once("finish", recordResponseBytes);
  response.once("close", recordResponseBytes);
  next();
});
app.use((request, response, next) => {
  // Export downloads have their own single global lease and 5 MiB/s limiter.
  // Keep them outside the short-lived API/static concurrency budget.
  if (/^\/api\/exports\/[^/]+\/download$/.test(request.path)) {
    next();
    return;
  }
  const release = normalHttpGate.tryAcquire();
  if (!release) {
    response.status(503);
    response.setHeader("Retry-After", "2");
    response.setHeader("Connection", "close");
    response.json({ error: "Too many HTTP requests are already in progress" });
    return;
  }
  response.once("finish", release);
  response.once("close", release);
  next();
});
app.use(express.json({ limit: "256kb" }));

function originAllowed(request: IncomingMessage): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if (!origin) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function clientAddress(request: express.Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function adminSession(request: express.Request) {
  return adminAuth.session(request.headers.cookie, clientAddress(request));
}

function settingsResponse(request: express.Request): SettingsRevision {
  const session = adminSession(request);
  const schedulerHealth = monitor.getSchedulerHealth();
  return {
    settings: settingsStore.settings,
    catalog: config.bandCatalog,
    effectiveBands: config.bands,
    configurationHash: config.configurationHash,
    estimatedRevisitMs: estimateRevisitMs(config.bands, config.sampleRateHz),
    feasibility: evaluateSettingsFeasibility({
      settings: settingsStore.settings,
      catalog: config.bandCatalog,
      sampleRateHz: config.sampleRateHz,
      schedulerHealth,
      measurementAvailable: !monitor.getCommissioningHealth().simulation,
    }),
    baselineStates: monitor.getBaselineStates(),
    baselineApprovals: monitor.getBaselineApprovalEligibility(),
    commissioning: monitor.getCommissioningHealth(),
    admin: { available: adminAuth.available, unlocked: session.unlocked, expiresAt: session.expiresAt },
    infrastructure: {
      dataDomain: config.dataDomain,
      receiverUrls: config.receiverUrls,
      sampleRateHz: config.sampleRateHz,
      storageRoot: config.storageRoot,
      bindAddress: `${config.host}:${config.port}`,
    },
  };
}

function requireAdmin(request: express.Request, response: express.Response): boolean {
  if (request.headers["x-rf-monitor-csrf"] !== "settings-v1") {
    response.status(403).json({ error: "A valid same-origin settings request is required" });
    return false;
  }
  if (!adminSession(request).unlocked) {
    response.status(401).json({ error: "Enter admin mode before applying changes" });
    return false;
  }
  return true;
}

function boundedIdentifier(value: string | string[] | undefined): string {
  const selected = Array.isArray(value) ? value[0] : value;
  if (!selected || !/^[A-Za-z0-9._-]+$/.test(selected)) throw new Error("Invalid identifier");
  return selected;
}

function exportResponse(job: ReturnType<typeof exportQueue.submit>) {
  return {
    ...job,
    statusUrl: `/api/exports/${job.id}`,
    downloadUrl: `/api/exports/${job.id}/download`,
    parts: job.parts?.map((part) => ({
      ...part,
      downloadUrl: `/api/exports/${job.id}/download?part=${part.number}`,
    })),
  };
}

function exportBuildPressure(): boolean {
  return currentResourceHealth().admitExports === false;
}

async function submitSessionExport(sessionId: string) {
  const prepared = await monitor.prepareSessionExport(sessionId);
  if (!prepared) throw Object.assign(new Error("Evidence session is unavailable"), { code: "EVIDENCE_SOURCE_UNAVAILABLE" });
  return exportQueue.submit(
    { kind: "session", sessionId: prepared.sessionId },
    { deduplicationKey: prepared.commitKey, estimatedOutputBytes: prepared.estimatedOutputBytes },
  );
}

function incidentExportReservationBytes(): number {
  return Math.min(Number.MAX_SAFE_INTEGER, config.retentionPolicy.sessionMaxBytes + 64 * 1024 * 1024);
}

function respondExportSubmissionError(response: express.Response, error: unknown): void {
  if (error instanceof ExportQueueFullError) {
    response.status(429).setHeader("Retry-After", "5").json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ExportProtectedBytesError) {
    response.status(503).setHeader("Retry-After", "30").json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof EvidenceExportSourceError) {
    response.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    response.status(404).json({ error: "Evidence session not found", code: "EVIDENCE_SOURCE_NOT_FOUND" });
    return;
  }
  if ((error as { code?: string })?.code === "EVIDENCE_SOURCE_UNAVAILABLE") {
    response.status(503).setHeader("Retry-After", "10").json({ error: "Evidence session is unavailable", code: "EVIDENCE_SOURCE_UNAVAILABLE" });
    return;
  }
  response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

function receiverStreamReady(): boolean {
  return monitor.getSnapshot().receivers.some((receiver) => receiver.streamReady === true);
}

function currentReceiverRecoveryOperation(now = Date.now()): RecoveryOperationState {
  return recoveryOperationState(receiverRecoveryStatus, receiverStreamReady(), now);
}

function currentApplicationRecoveryOperation(now = Date.now()): RecoveryOperationState {
  return recoveryOperationState(applicationRecoveryStatus, true, now);
}

async function refreshRecoverySupervisorState(): Promise<void> {
  if (recoveryStatusRefreshInFlight) return recoveryStatusRefreshInFlight;
  recoveryStatusRefreshInFlight = (async () => {
    const [receiver, application] = await Promise.all([
      readRecoverySupervisorStatus(receiverRecoveryStatusPath),
      readRecoverySupervisorStatus(applicationRecoveryStatusPath),
    ]);
    receiverRecoveryStatus = receiver;
    applicationRecoveryStatus = application;
    if (receiver.availability === "available" && receiver.fresh) monitor.noteRecoverySupervisorStatus(receiver.status);
    if (application.availability === "available" && application.fresh) monitor.noteApplicationRecoverySupervisorStatus(application.status);
    if (receiver.availability === "available" && receiver.fresh) {
      const active = receiver.status.state !== "live";
      stabilityIncidents.note("receiver-recovery", active, receiver.status.state === "lockout" ? "critical" : "attention", [receiver.status.reasonCode]);
      stabilityIncidents.note("recovery-lockout", receiver.status.state === "lockout", "critical", [receiver.status.reasonCode]);
    }
    if (application.availability === "available" && application.fresh) {
      const active = application.status.state !== "live";
      stabilityIncidents.note("application-recovery", active, application.status.state === "lockout" ? "critical" : "attention", [application.status.reasonCode]);
      if (application.status.state === "lockout") stabilityIncidents.note("recovery-lockout", true, "critical", [application.status.reasonCode]);
    }
  })().finally(() => { recoveryStatusRefreshInFlight = undefined; });
  return recoveryStatusRefreshInFlight;
}

function currentResourceHealth(): ResourceHealth {
  const now = Date.now();
  if (resourceHealthCache && now - resourceHealthCache.at < 250) return resourceHealthCache.value;
  const memory = process.memoryUsage();
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  const heapUtilization = heapLimitBytes ? memory.heapUsed / heapLimitBytes : 0;
  const writer = monitor.getWriterHealth();
  const storage = monitor.getSnapshot().storagePolicy;
  const currentP50 = eventLoopHistogram.percentile(50) / 1_000_000;
  const currentP99 = eventLoopHistogram.percentile(99) / 1_000_000;
  const p50Ms = Math.max(Number.isFinite(currentP50) ? currentP50 : 0, ...eventLoopSamples.map((sample) => sample.p50Ms), 0);
  const p99Ms = Math.max(Number.isFinite(currentP99) ? currentP99 : 0, ...eventLoopSamples.map((sample) => sample.p99Ms), 0);
  const hostMemory = hostMemoryController.sample(now);
  const policy = resourceBudget.update({
    rssBytes: memory.rss,
    heapUtilization,
    externalBytes: memory.external,
    writerQueueItems: writer.queueItems,
    writerQueueBytes: writer.queueBytes,
    writerOldestAgeMs: writer.oldestAgeMs,
    eventLoopDelayP99Ms: p99Ms,
    diskBelowReserve: storage.availableBytes !== undefined && storage.availableBytes < storage.minimumFreeBytes,
    hostMemoryState: hostMemory.state,
    recentOomKill: hostMemory.recentOomKill,
  }, now);
  const hostPressure = hostMemory.state === "pressure" || hostMemory.state === "critical";
  stabilityIncidents.note(
    hostMemory.recentOomKill ? "oom-kill" : "host-memory-pressure",
    hostPressure,
    hostMemory.state === "critical" ? "critical" : "attention",
    hostMemory.reasonCodes,
    new Date(now),
  );
  if (!hostMemory.recentOomKill) stabilityIncidents.note("oom-kill", false, "critical", [], new Date(now));
  if (!hostPressure) stabilityIncidents.note("host-memory-pressure", false, "attention", [], new Date(now));
  const value: ResourceHealth = {
    state: policy.state,
    reasonCodes: policy.reasons,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes,
    heapUtilization: Number(heapUtilization.toFixed(4)),
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    eventLoopDelayP50Ms: Number(p50Ms.toFixed(2)),
    eventLoopDelayP99Ms: Number(p99Ms.toFixed(2)),
    writerQueueItems: writer.queueItems,
    writerQueueBytes: writer.queueBytes,
    writerOldestAgeMs: writer.oldestAgeMs,
    diskWriteBytesPerSecond10s: writer.diskWriteBytesPerSecond10s,
    diskFreeBytes: storage.availableBytes,
    exportsActive: exportQueue.activeBuildJobId || exportQueue.downloadActive ? 1 : 0,
    exportsQueued: exportQueue.queuedCount,
    baselineBytes: monitor.getBaselineAllocationBytes(),
    ringBytes: monitor.getRingAllocationBytes(),
    dashboardsStatusOnly: policy.dashboardsStatusOnly,
    admitLiveClients: policy.admitLiveClients,
    admitExports: policy.admitExports,
    maxDashboardRateHz: policy.maxDashboardRateHz,
    hostMemory,
    pressureEnteredAt: new Date(policy.enteredAt).toISOString(),
    healthySince: policy.healthySince === undefined ? undefined : new Date(policy.healthySince).toISOString(),
  };
  monitor.noteResourceHealth(value);
  resourceHealthCache = { at: now, value };
  return value;
}

function downloadRateLimiter(bytesPerSecond = 5 * 1024 * 1024): Transform {
  const startedAt = performance.now();
  let bytesSent = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesSent += chunk.byteLength;
      const dueAt = startedAt + (bytesSent / bytesPerSecond) * 1_000;
      const delayMs = Math.max(0, dueAt - performance.now());
      if (delayMs < 1) callback(null, chunk);
      else setTimeout(() => callback(null, chunk), delayMs);
    },
  });
}

function compactSnapshot(snapshot: MonitorSnapshot, engineer = false): MonitorSnapshot {
  const compactEvent = (event: DetectionEvent | undefined) => event ? {
    ...event,
    notes: event.notes.slice(-8).map((note) => ({ ...note, text: note.text.slice(0, 512) })),
  } : undefined;
  return {
    ...snapshot,
    currentFrame: snapshot.currentFrame ? { ...snapshot.currentFrame, bins: new Uint8Array() } : undefined,
    waterfall: [],
    sweepCycles: snapshot.sweepCycles.map((cycle) => ({
      ...cycle,
      stitchedFrame: cycle.stitchedFrame ? { ...cycle.stitchedFrame, bins: new Uint8Array() } : undefined,
      waterfall: [],
    })),
    panorama: engineer ? snapshot.panorama.map((segment) => ({ ...segment, bins: new Uint8Array() })) : [],
    activeEvent: compactEvent(snapshot.activeEvent),
    events: snapshot.events.slice(0, 10).map((event) => compactEvent(event)!),
    sessions: snapshot.sessions.slice(0, 6),
  };
}

function compactStateDelta(snapshot: MonitorSnapshot, engineer = false): MonitorStateDelta {
  const compact = compactSnapshot(snapshot, engineer);
  return {
    generatedAt: compact.generatedAt,
    dataDomain: compact.dataDomain,
    identity: compact.identity,
    operatorSummary: compact.operatorSummary,
    status: compact.status,
    operatorStatus: compact.operatorStatus,
    monitoringReady: compact.monitoringReady,
    monitoringIssue: compact.monitoringIssue,
    paused: compact.paused,
    coverageGaps: compact.coverageGaps,
    activeFocus: compact.activeFocus,
    syntheticExercise: compact.syntheticExercise,
    receivers: compact.receivers,
    targetStates: compact.targetStates,
    activeEvent: compact.activeEvent,
    events: compact.events,
    currentMetrics: compact.currentMetrics,
    evidenceHealthy: compact.evidenceHealthy,
    lastUpdatedAt: compact.lastUpdatedAt,
    dashboardsStatusOnly: currentResourceHealth().dashboardsStatusOnly,
    sweepCycles: compact.sweepCycles,
    ...(engineer ? { panorama: compact.panorama } : {}),
  };
}

function observeProductionQualification(snapshot: MonitorSnapshot): ProductionQualification {
  const receiver = snapshot.receivers.length === 1 ? snapshot.receivers[0] : undefined;
  return productionQualificationStore.observe({
    identity: snapshot.identity,
    commissioning: monitor.getCommissioningHealth(),
    protectedBaselinesReady: monitor.getProtectedBaselineReadiness().ready,
    site: { siteName: snapshot.siteName, deploymentId: snapshot.deploymentId },
    receiver: { model: receiver?.deviceName, serial: receiver?.deviceSerial },
    evaluatedAt: snapshot.generatedAt,
  });
}

function currentHealthForSnapshot(
  snapshot: MonitorSnapshot,
  diagnosticsState: DiagnosticSummaryState,
  resources: ResourceHealth,
  issueCount: number,
): CurrentMonitoringHealth {
  const simulation = snapshot.dataDomain === "test";
  const critical = diagnosticsState === "critical"
    || !snapshot.evidenceHealthy
    || snapshot.storagePolicy.pressure
    || resources.state === "critical";
  const attention = diagnosticsState === "attention"
    || !snapshot.monitoringReady
    || resources.state === "pressure";
  const state: DiagnosticSummaryState = simulation
    ? "simulation"
    : critical
      ? "critical"
      : attention
        ? "attention"
        : "normal";
  return {
    state,
    ready: !simulation
      && state === "normal"
      && snapshot.monitoringReady
      && snapshot.evidenceHealthy
      && !snapshot.storagePolicy.pressure
      && resources.state === "normal",
    monitoringReady: snapshot.monitoringReady,
    evidenceReady: snapshot.evidenceHealthy && !snapshot.storagePolicy.pressure,
    issueCount,
    evaluatedAt: snapshot.generatedAt,
  };
}

function authoritativeSnapshot(
  source = monitor.getSnapshot(),
  options: {
    diagnosticsState?: DiagnosticSummaryState;
    diagnosticIssueCount?: number;
    resources?: ResourceHealth;
    productionQualification?: ProductionQualification;
  } = {},
): { snapshot: MonitorSnapshot; currentHealth: CurrentMonitoringHealth; productionQualification: ProductionQualification } {
  const resources = options.resources ?? currentResourceHealth();
  const diagnostics = diagnosticsCollector.snapshot();
  const currentHealth = currentHealthForSnapshot(
    source,
    options.diagnosticsState ?? diagnostics.summary.state,
    resources,
    options.diagnosticIssueCount ?? diagnostics.summary.issues.length,
  );
  const productionQualification = options.productionQualification ?? observeProductionQualification(source);
  const writer = monitor.getWriterHealth();
  const activeRecording = source.sessions.find((session) => session.lifecycle === "Active" || session.status === "recording");
  const recordingState = !source.evidenceHealthy
    || source.storagePolicy.pressure
    || writer.oldestAgeMs >= 2_000
    || writer.queueItems >= WRITER_ORDINARY_MAX_ITEMS
    || writer.queueBytes >= WRITER_ORDINARY_MAX_BYTES
    ? "error" as const
    : activeRecording
      ? "recording" as const
      : "stopped" as const;
  return {
    snapshot: applyAuthoritativeOperatorRuntime(source, {
      productionQualification,
      currentHealthState: currentHealth.state,
      recordingState,
    }),
    currentHealth,
    productionQualification,
  };
}

function streamingHealth(clientCount: number): StreamingHealth {
  const elapsedSeconds = Math.max(1, (Date.now() - streamingStartedAt) / 1_000);
  const traffic = outboundTraffic.snapshot();
  return {
    clients: clientCount,
    ...streamingCounters,
    outboundBytesPerSecond: Math.round(streamingCounters.outboundBytes / elapsedSeconds),
    outboundBytesPerSecond10s: traffic.liveBytesPerSecond10s,
    outboundBytesPerSecond60s: traffic.liveBytesPerSecond60s,
    startedAt: new Date(streamingStartedAt).toISOString(),
    visibleClients: [...liveClients.values()].filter((client) => client.subscription.rateHz !== 0.2).length,
    hiddenClients: [...liveClients.values()].filter((client) => client.subscription.rateHz === 0.2).length,
  };
}

function diagnosticsRuntimeSample(): DiagnosticsRuntimeSample {
  const snapshot = monitor.getSnapshot();
  const commissioning = monitor.getCommissioningHealth();
  return {
    generatedAt: snapshot.generatedAt,
    simulation: snapshot.receivers.some((receiver) => receiver.connection === "simulated"),
    expectedSampleRateHz: config.sampleRateHz,
    receivers: snapshot.receivers,
    processing: monitor.getProcessingHealth(),
    scheduler: monitor.getSchedulerHealth(),
    commissioning,
    streaming: streamingHealth(typeof liveServer === "undefined" ? 0 : liveServer.clients.size),
    resources: currentResourceHealth(),
    evidenceHealthy: snapshot.evidenceHealthy,
    evidenceArchive: monitor.getEvidenceArchiveHealth(),
    diskPressure: snapshot.storagePolicy.pressure,
  };
}

function healthResponse(): HealthSnapshotV2 & Record<string, unknown> {
  let snapshot = monitor.getSnapshot();
  const resources = currentResourceHealth();
  const writer = monitor.getWriterHealth();
  const scheduler = monitor.getSchedulerHealth();
  const qualification = monitor.getCommissioningHealth();
  const processing = monitor.getProcessingHealth();
  const streamHealth = streamingHealth(liveServer.clients.size);
  const simulationActive = snapshot.receivers.some((receiver) => receiver.connection === "simulated");
  const runtime: DiagnosticsRuntimeSample = {
    generatedAt: snapshot.generatedAt,
    simulation: simulationActive,
    expectedSampleRateHz: config.sampleRateHz,
    receivers: snapshot.receivers,
    processing,
    scheduler,
    commissioning: qualification,
    streaming: streamHealth,
    resources,
    evidenceHealthy: snapshot.evidenceHealthy,
    evidenceArchive: monitor.getEvidenceArchiveHealth(),
    diskPressure: snapshot.storagePolicy.pressure,
  };
  diagnosticsCollector.updateRuntime(runtime);
  const diagnostics = diagnosticsCollector.snapshot();
  const qualificationReceiver = snapshot.receivers.length === 1 ? snapshot.receivers[0] : undefined;
  const observedQualification = productionQualificationStore.observe({
    identity: snapshot.identity,
    commissioning: qualification,
    protectedBaselinesReady: monitor.getProtectedBaselineReadiness().ready,
    site: { siteName: snapshot.siteName, deploymentId: snapshot.deploymentId },
    receiver: { model: qualificationReceiver?.deviceName, serial: qualificationReceiver?.deviceSerial },
    evaluatedAt: snapshot.generatedAt,
  });
  const authoritative = authoritativeSnapshot(snapshot, {
    diagnosticsState: diagnostics.summary.state,
    diagnosticIssueCount: diagnostics.summary.issues.length,
    resources,
    productionQualification: observedQualification,
  });
  snapshot = authoritative.snapshot;
  const currentHealth = authoritative.currentHealth;
  const productionQualification = authoritative.productionQualification;
  const productionQualificationHistory = productionQualificationStore.history(productionQualification.epochId);
  const productionReady = productionReadyForHealth(currentHealth, productionQualification);
  const traffic = outboundTraffic.snapshot();
  const receiverStages = snapshot.receivers.map((receiver) => ({
    id: receiver.id,
    socketOpen: receiver.socketConnected,
    apiReady: receiver.apiReady,
    deviceReady: receiver.deviceReady,
    streamReady: receiver.streamReady,
    tuneState: receiver.tuneState,
    issueCode: receiver.lastError ? "receiver-reported-error" : undefined,
  }));
  const commissioningState = simulationActive
    ? "simulation"
    : receiverStages.some((receiver) => !receiver.socketOpen)
      ? "socket-pending"
      : receiverStages.some((receiver) => !receiver.apiReady)
        ? "api-pending"
        : receiverStages.some((receiver) => !receiver.deviceReady)
          ? "hardware-pending"
          : !snapshot.monitoringReady
            ? "stream-pending"
            : qualification.state;
  const safeReceivers = snapshot.receivers.map((receiver) => ({
    id: receiver.id,
    connection: receiver.connection,
    activeBandId: receiver.activeBandId,
    activeWindowId: receiver.activeWindowId,
    tunedCenterHz: receiver.tunedCenterHz,
    confirmedCenterHz: receiver.confirmedCenterHz,
    confirmedSampleRateHz: receiver.confirmedSampleRateHz,
    activeAntenna: simulationActive ? undefined : receiver.activeAntenna,
    lastFrameAt: receiver.lastFrameAt,
    apiVersion: receiver.apiVersion,
    socketConnected: simulationActive ? false : receiver.socketConnected,
    apiReady: simulationActive ? false : receiver.apiReady,
    deviceReady: simulationActive ? false : receiver.deviceReady,
    streamReady: simulationActive ? false : receiver.streamReady,
    tuneState: simulationActive ? "idle" : receiver.tuneState,
    tuneConfirmedAt: receiver.tuneConfirmedAt,
    hardwareState: simulationActive ? "unknown" : receiver.hardwareState,
    transportState: simulationActive ? "offline" : receiver.transportState,
    streamState: simulationActive ? "stopped" : receiver.streamState,
    recoveryState: receiver.recoveryState,
    lastFrameAgeMs: receiver.lastFrameAgeMs,
    reconnectAttempts: receiver.reconnectAttempts,
    nextRetryAt: receiver.nextRetryAt,
    errorCode: receiver.lastError ? "receiver-reported-error" : undefined,
    simulation: simulationActive,
  }));
  const queuedBytes = [...liveClients.entries()].reduce((total, [socket, state]) => (
    total + socket.bufferedAmount + state.pendingFrameBytes + state.controlQueue.pendingBytes
  ), 0);
  const v2: HealthSnapshotV2 = {
    schemaVersion: 2,
    generatedAt: snapshot.generatedAt,
    identity: snapshot.identity,
    currentHealth,
    productionQualification,
    productionQualificationHistory,
    productionReady,
    summary: diagnostics.summary,
    recovery: {
      receiver: currentReceiverRecoveryOperation(),
      application: currentApplicationRecoveryOperation(),
    },
    receiverPath: {
      availability: simulationActive
        ? { state: "not-tested", reasonCode: "simulation-active" }
        : { state: snapshot.receivers.length ? "available" : "unavailable", reasonCode: snapshot.receivers.length ? undefined : "receiver-not-configured", lastSampleAt: snapshot.generatedAt },
      expectedSampleRateHz: config.sampleRateHz,
      receivers: snapshot.receivers.map((receiver) => ({
        id: receiver.id,
        usb: simulationActive ? "not-tested" : receiver.hardwareState ?? "unknown",
        transport: simulationActive ? "not-tested" : receiver.transportState ?? "offline",
        frames: simulationActive ? "not-tested" : receiver.streamState ?? "stopped",
        tuneState: receiver.tuneState,
        confirmedSampleRateHz: receiver.confirmedSampleRateHz,
        activeAntenna: simulationActive ? undefined : receiver.activeAntenna,
        sampleRateMatches: receiver.confirmedSampleRateHz === undefined ? undefined : receiver.confirmedSampleRateHz === config.sampleRateHz,
        reconnectAttempts: receiver.reconnectAttempts ?? 0,
        recoveryState: receiver.recoveryState,
        lastFrameAgeMs: receiver.lastFrameAgeMs,
        lastHardwareError: receiver.lastError ? "receiver-reported-error" : undefined,
      })),
    },
    dataContinuity: diagnostics.dataContinuity,
    software: {
      processCollector: diagnostics.processCollector,
      hostCollector: diagnostics.hostCollector,
      rfMonitorCpuHostNormalized: diagnostics.rfMonitorCpuHostNormalized,
      rfMonitorCpuCoreEquivalent: diagnostics.rfMonitorCpuCoreEquivalent,
      hostCpu: diagnostics.hostCpu,
      hostLoad1m: diagnostics.hostLoad1m,
      rssBytes: resources.rssBytes,
      heapUsedBytes: resources.heapUsedBytes,
      heapLimitBytes: resources.heapLimitBytes,
      externalBytes: resources.externalBytes,
      arrayBufferBytes: resources.arrayBuffersBytes,
      eventLoopDelayP50Ms: resources.eventLoopDelayP50Ms,
      eventLoopDelayP99Ms: resources.eventLoopDelayP99Ms,
      sdrconnect: diagnostics.sdrconnect,
      hostMemory: resources.hostMemory,
      stabilityIncidents: stabilityIncidents.list(),
    },
    network: {
      hostCollector: diagnostics.networkCollector,
      interfaces: diagnostics.networkInterfaces,
      managedSwitch: { availability: { state: "not-applicable", reasonCode: "external-not-connected" } },
      liveBytesPerSecond10s: traffic.liveBytesPerSecond10s,
      liveBytesPerSecond60s: traffic.liveBytesPerSecond60s,
      applicationBytesPerSecond10s: traffic.applicationBytesPerSecond10s,
      applicationBytesPerSecond60s: traffic.applicationBytesPerSecond60s,
      dashboards: liveServer.clients.size,
      queuedBytes,
      drops: diagnostics.browserDrops,
      clients: [...liveClients.entries()].map(([socket, state]) => ({
        id: state.id,
        connectedAt: new Date(state.connectedAt).toISOString(),
        ageMs: Math.max(0, Date.now() - state.connectedAt),
        visibility: state.subscription.rateHz === 0.2 ? "hidden" : "visible",
        rateHz: state.subscription.rateHz,
        engineer: state.subscription.engineer,
        targetCount: state.subscription.visibleTargetIds.length + state.subscription.visibleFeedIds.length,
        lastDeliveredFrameAt: state.lastDeliveredFrameAt ? new Date(state.lastDeliveredFrameAt).toISOString() : undefined,
        bufferedBytes: socket.bufferedAmount,
        queuedBytes: state.pendingFrameBytes + state.controlQueue.pendingBytes + socket.bufferedAmount,
      })),
    },
    evidence: {
      healthy: snapshot.evidenceHealthy,
      writerQueueItems: writer.queueItems,
      writerQueueBytes: writer.queueBytes,
      writerOldestAgeMs: writer.oldestAgeMs,
      writeBytesPerSecond10s: resources.diskWriteBytesPerSecond10s,
      diskFreeBytes: resources.diskFreeBytes,
      diskReserveBytes: snapshot.storagePolicy.minimumFreeBytes,
      diskPressure: snapshot.storagePolicy.pressure,
      exportsActive: resources.exportsActive,
      exportsQueued: resources.exportsQueued,
      baselineBytes: resources.baselineBytes,
      ringBytes: resources.ringBytes,
      archive: monitor.getEvidenceArchiveHealth(),
    },
    schedule: {
      health: scheduler,
      targets: monitor.getTargetTimingHealth(),
      commissioning: qualification,
      baselines: monitor.getBaselineStates(),
    },
  };
  const compatibilityNetwork = {
    ...v2.network,
    livePayloadLimitBytesPerSecond: 1024 * 1024,
    liveBurstBytes: 2 * 1024 * 1024,
    liveOutboundBytes: traffic.liveBytes,
    liveOutboundBytesPerSecond10s: traffic.liveBytesPerSecond10s,
    liveOutboundBytesPerSecond60s: traffic.liveBytesPerSecond60s,
    outboundBytesPerSecond10s: traffic.liveBytesPerSecond10s,
    outboundBytesPerSecond60s: traffic.liveBytesPerSecond60s,
    httpOutboundBytes: traffic.httpBytes,
    httpOutboundBytesPerSecond10s: traffic.httpBytesPerSecond10s,
    httpOutboundBytesPerSecond60s: traffic.httpBytesPerSecond60s,
    applicationOutboundBytes: traffic.applicationBytes,
    normalHttpActiveRequests: normalHttpGate.active,
    normalHttpRequestLimit: normalHttpGate.limit,
    normalHttpRejectedRequests: normalHttpGate.rejected,
    clients: [...liveClients.entries()].map(([socket, state]) => ({
      id: state.id,
      connectedAt: new Date(state.connectedAt).toISOString(),
      ageMs: Math.max(0, Date.now() - state.connectedAt),
      visibility: state.subscription.rateHz === 0.2 ? "hidden" as const : "visible" as const,
      rateHz: state.subscription.rateHz,
      engineer: state.subscription.engineer,
      targetCount: state.subscription.visibleTargetIds.length + state.subscription.visibleFeedIds.length,
      lastDeliveredFrameAt: state.lastDeliveredFrameAt ? new Date(state.lastDeliveredFrameAt).toISOString() : undefined,
      visibleTargets: state.subscription.visibleTargetIds.length + state.subscription.visibleFeedIds.length,
      visibleFeeds: state.subscription.visibleFeedIds.length,
      queuedTargets: state.pendingFrames.size,
      applicationQueuedBytes: state.pendingFrameBytes + state.controlQueue.pendingBytes,
      bufferedBytes: socket.bufferedAmount,
      queuedBytes: state.pendingFrameBytes + state.controlQueue.pendingBytes + socket.bufferedAmount,
      pressureMs: state.pressureSince ? Math.max(0, Date.now() - state.pressureSince) : 0,
    })),
  };
  return {
    ...v2,
    operatorSummary: snapshot.operatorSummary,
    dataDomain: monitor.getDataDomainStatus(),
    // One-release compatibility aliases. `productionReady` is authoritative;
    // `ok` is now deliberately fail-closed instead of meaning "not critical".
    ok: productionReady,
    status: snapshot.status,
    monitoringReady: snapshot.monitoringReady,
    monitoringIssue: snapshot.monitoringIssue,
    evidenceHealthy: snapshot.evidenceHealthy,
    timestampStandard: snapshot.timestampStandard,
    displayTimeZone: snapshot.displayTimeZone,
    storagePolicy: snapshot.storagePolicy,
    receivers: safeReceivers,
    commissioning: {
      state: commissioningState,
      ready: productionQualification.ready,
      qualification,
      productionQualification,
      receivers: receiverStages,
      scan: {
        profile: snapshot.configuration.scanProfile,
        priorityWindowId: snapshot.configuration.priorityWindowId,
        plannedMaximumGapMs: snapshot.configuration.maxPriorityGapMs,
        measuredMaximumGapMs: snapshot.configuration.measuredPriorityGapMs,
      },
    },
    streaming: streamHealth,
    network: compatibilityNetwork,
    scheduler,
    baselines: { states: v2.schedule.baselines, allocationBytes: resources.baselineBytes },
    processing,
    resources,
    memory: {
      residentBytes: resources.rssBytes,
      heapUsedBytes: resources.heapUsedBytes,
      heapLimitBytes: resources.heapLimitBytes,
      heapUtilization: resources.heapUtilization,
      externalBytes: resources.externalBytes,
      arrayBufferBytes: resources.arrayBuffersBytes,
      eventLoopDelayP50Ms: resources.eventLoopDelayP50Ms,
      eventLoopDelayP99Ms: resources.eventLoopDelayP99Ms,
    },
    writer,
    disk: {
      availableBytes: resources.diskFreeBytes,
      minimumFreeBytes: snapshot.storagePolicy.minimumFreeBytes,
      writeBytesPerSecond10s: resources.diskWriteBytesPerSecond10s,
      pressure: snapshot.storagePolicy.pressure,
    },
    exports: {
      activeBuildJobId: exportQueue.activeBuildJobId,
      activeDownload: exportQueue.downloadActive,
      queued: exportQueue.queuedCount,
      recent: exportQueue.list().slice(0, 16).map((job) => ({
        id: job.id,
        state: job.state,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        sizeBytes: job.sizeBytes,
        errorCode: job.error ? "export-failed" : undefined,
      })),
    },
  };
}

app.use("/api", (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !originAllowed(request)) {
    response.status(403).json({ error: "A same-origin dashboard request is required" });
    return;
  }
  next();
});

app.get("/api/health", (_request, response) => response.json(healthResponse()));
app.get("/api/health/diagnostics.json", (_request, response) => {
  response.setHeader("Content-Disposition", 'attachment; filename="rf-monitor-diagnostics.json"');
  response.type("application/json").send(`${JSON.stringify(healthResponse(), null, 2)}\n`);
});

function syntheticValidationAvailable(response: express.Response): boolean {
  if (config.simulation === "on") return true;
  response.status(404).json({ error: "Synthetic validation is available only in simulation mode" });
  return false;
}

function syntheticExerciseAvailable(response: express.Response): boolean {
  if (config.simulation === "on" && config.syntheticExercises) return true;
  response.status(404).json({ error: "Live synthetic exercises are not enabled" });
  return false;
}

function sendBoundedSyntheticValidation(response: express.Response, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > MAX_SYNTHETIC_VALIDATION_RESPONSE_BYTES) {
    response.status(500).json({ error: "Synthetic validation report exceeded its size limit" });
    return;
  }
  response.type("application/json").send(encoded);
}

app.get("/api/validation/scenarios", (_request, response) => {
  if (!syntheticValidationAvailable(response)) return;
  sendBoundedSyntheticValidation(response, {
    schemaVersion: 1,
    synthetic: true,
    source: "isolated-simulation",
    livePlaybackAvailable: config.simulation === "on" && config.syntheticExercises,
    modes: ["guided", "blinded"],
    scenarios: listSyntheticQualificationScenarios(config.bandCatalog),
  });
});

app.get("/api/validation/plan", (_request, response) => {
  if (!syntheticValidationAvailable(response)) return;
  const plan = detectorQualificationPlan(config.bandCatalog);
  sendBoundedSyntheticValidation(response, {
    schemaVersion: 1,
    qualification: true,
    planHash: sha256Canonical(plan),
    plan,
    status: {
      isolatedDeterministic: "available",
      isolatedRandomized: "defined-not-run",
      heldOutReplay: "external-data-required",
      installedChain: "physical-hardware-required",
    },
  });
});

app.post("/api/validation/runs", (request, response) => {
  if (!syntheticValidationAvailable(response)) return;
  const scenarioId = typeof request.body?.scenarioId === "string" ? request.body.scenarioId : "";
  const mode = request.body?.mode as SyntheticRunMode | undefined;
  if (!/^[a-z0-9-]{1,64}$/.test(scenarioId) || (mode !== "guided" && mode !== "blinded")) {
    response.status(400).json({ error: "Scenario and mode are required" });
    return;
  }
  if (syntheticValidationRunActive) {
    response.status(429).setHeader("Retry-After", "1");
    response.json({ error: "A synthetic validation run is already active" });
    return;
  }
  syntheticValidationRunActive = true;
  try {
    const report = runSyntheticQualificationScenario(scenarioId, mode, {
      bandCatalog: config.bandCatalog,
      thresholds: config.operationalSettings.detection,
      softwareBuild: {
        package: "rf-monitor",
        version: config.runtimeIdentity.release.releaseVersion,
        buildId: config.runtimeIdentity.release.buildId,
        sourceDigest: config.runtimeIdentity.release.sourceDigest,
        packageDigest: config.runtimeIdentity.release.packageDigest,
        dependencyLockDigest: config.runtimeIdentity.release.dependencyLockDigest,
      },
      configuration: {
        configurationHash: config.configurationHash,
        catalogVersion: config.bandCatalog.catalogVersion,
        sampleRateHz: config.sampleRateHz,
        analysisSpanHz: 8_000_000,
      },
    });
    sendBoundedSyntheticValidation(response, report);
  } catch (error) {
    if (error instanceof Error && error.message === "Unknown synthetic validation scenario") {
      response.status(404).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: "Synthetic validation run failed" });
  } finally {
    syntheticValidationRunActive = false;
  }
});

app.get("/api/validation/playback", (_request, response) => {
  if (!syntheticExerciseAvailable(response)) return;
  response.json({ schemaVersion: 1, synthetic: true, playback: monitor.getSyntheticExercise() ?? null });
});

app.post("/api/validation/playback", (request, response) => {
  if (!syntheticExerciseAvailable(response)) return;
  const scenarioId = typeof request.body?.scenarioId === "string" ? request.body.scenarioId : "";
  const targetId = request.body?.targetId === undefined
    ? undefined
    : typeof request.body.targetId === "string" ? request.body.targetId : "";
  if (!/^[a-z0-9-]{1,64}$/.test(scenarioId) || (targetId !== undefined && !/^[a-z0-9-]{1,128}$/.test(targetId))) {
    response.status(400).json({ error: "Select a valid scenario and target" });
    return;
  }
  try {
    response.status(202).json({ schemaVersion: 1, synthetic: true, playback: monitor.startSyntheticExercise(scenarioId, targetId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unknown synthetic exercise scenario/.test(message)) response.status(404).json({ error: message });
    else if (/already active|current incident|settings change|normal survey/.test(message)) response.status(409).json({ error: message });
    else response.status(422).json({ error: message });
  }
});

app.delete("/api/validation/playback", (_request, response) => {
  if (!syntheticExerciseAvailable(response)) return;
  response.json({ schemaVersion: 1, synthetic: true, playback: monitor.stopSyntheticExercise() ?? null });
});

app.get("/api/snapshot", (_request, response) => response.json(compactSnapshot(authoritativeSnapshot().snapshot)));
app.get("/api/bands", (_request, response) => response.json(config.bands));
app.get("/api/settings", (request, response) => response.json(settingsResponse(request)));

app.post("/api/admin/unlock", async (request, response) => {
  try {
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!password || password.length > 128) {
      response.status(400).json({ error: "Enter the settings password" });
      return;
    }
    const result = await adminAuth.unlock(password, clientAddress(request));
    response.setHeader("Set-Cookie", adminAuth.cookieHeader(result.cookie, request.secure));
    const payload = settingsResponse(request);
    payload.admin = { available: true, unlocked: true, expiresAt: result.expiresAt };
    response.json(payload);
  } catch (error) {
    if (error instanceof AdminAuthenticationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    response.status(500).json({ error: `Settings unlock failed: ${String(error)}` });
  }
});

app.get("/api/admin/session", (request, response) => {
  const session = adminSession(request);
  response.json({ available: adminAuth.available, unlocked: session.unlocked, expiresAt: session.expiresAt });
});

app.post("/api/admin/lock", (request, response) => {
  adminAuth.lock(request.headers.cookie, clientAddress(request));
  response.setHeader("Set-Cookie", adminAuth.clearCookieHeader(request.secure));
  response.json({ available: adminAuth.available, unlocked: false });
});

app.put("/api/settings", async (request, response) => {
  if (!requireAdmin(request, response)) return;
  const expectedRevision = Number(request.body?.expectedRevision);
  const incoming = request.body?.settings as OperationalSettings | undefined;
  if (!incoming || !Number.isInteger(expectedRevision)) {
    response.status(400).json({ error: "Settings and expectedRevision are required" });
    return;
  }
  let prepared;
  try {
    prepared = settingsStore.prepare(incoming, expectedRevision);
    const previousConfig = config;
    const nextConfig = withOperationalSettings(config, prepared.settings);
    await monitor.reconfigure(nextConfig);
    let auditEntry;
    try {
      auditEntry = await settingsStore.commit(prepared, "settings-admin", clientAddress(request));
    } catch (error) {
      await monitor.reconfigure(previousConfig).catch(() => undefined);
      throw error;
    }
    config = nextConfig;
    await monitor.recordConfigurationAudit(auditEntry);
    response.json(settingsResponse(request));
  } catch (error) {
    await settingsStore.recordRejected(error instanceof Error ? error.message : String(error), "settings-admin", clientAddress(request), prepared?.configurationHash).catch(() => undefined);
    if (error instanceof RevisionConflictError) {
      response.status(409).json({ error: error.message, currentRevision: error.currentRevision });
      return;
    }
    if (error instanceof SettingsValidationError) {
      response.status(422).json({ error: error.message, fields: error.fields });
      return;
    }
    response.status(500).json({ error: `Settings could not be applied: ${error instanceof Error ? error.message : String(error)}` });
  }
});

async function updateBaseline(
  action: "approve" | "restart",
  request: express.Request,
  response: express.Response,
): Promise<void> {
  if (!requireAdmin(request, response)) return;
  const expectedRevision = Number(request.body?.expectedConfigurationRevision ?? request.body?.expectedRevision);
  const expectedFingerprintId = typeof request.body?.expectedFingerprintId === "string" ? request.body.expectedFingerprintId : "";
  const expectedGeneration = Number(request.body?.expectedGeneration);
  if (!Number.isInteger(expectedRevision) || !/^[a-f0-9]{64}$/.test(expectedFingerprintId) || !Number.isInteger(expectedGeneration) || expectedGeneration <= 0) {
    response.status(400).json({ error: "Expected configuration revision, fingerprint, and learning generation are required" });
    return;
  }
  if (expectedRevision !== settingsStore.settings.revision) {
    response.status(409).json({
      error: `Settings changed since this page was opened. Reload revision ${settingsStore.settings.revision}.`,
      currentRevision: settingsStore.settings.revision,
    });
    return;
  }
  try {
    const targetId = Array.isArray(request.params.targetId) ? request.params.targetId[0] : request.params.targetId;
    const common = {
      targetId,
      expectedFingerprintId,
      expectedGeneration,
    };
    if (action === "approve") {
      const descriptor = await monitor.approveBaseline({ ...common, approvedBy: "settings-admin" });
      response.json({ configurationRevision: settingsStore.settings.revision, baseline: descriptor });
      return;
    }
    const result = await monitor.restartBaseline({
      ...common,
      restartedBy: "settings-admin",
      endActiveObservation: request.body?.endActiveObservation === true,
    });
    response.status(result.state === "complete" ? 200 : 202).json({
      configurationRevision: settingsStore.settings.revision,
      baseline: result.baseline,
      operation: {
        operationId: result.operationId,
        committed: result.committed,
        state: result.state,
        auditDurable: result.auditDurable,
        recoveryReason: result.recoveryReason,
      },
    });
  } catch (error) {
    if (error instanceof CommittedBaselineRestartRecoveryError) {
      response.status(202).json({
        configurationRevision: settingsStore.settings.revision,
        operation: {
          operationId: error.operation.operationId,
          committed: true,
          state: "recovery-required",
          auditDurable: error.operation.phase === "audited",
          recoveryReason: error.message,
        },
      });
      return;
    }
    if (error instanceof BaselineConflictError || /exact active baseline fingerprint/i.test(error instanceof Error ? error.message : "")) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (error instanceof BaselineNotReviewableError) {
      response.status(422).json({ error: error.message, lifecycle: error.lifecycle });
      return;
    }
    if (error instanceof BaselineApprovalUnavailableError) {
      response.status(422).json({
        error: error.message,
        code: error.code,
        approval: error.approval,
        commissioning: monitor.getCommissioningHealth(),
      });
      return;
    }
    response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

app.post("/api/baselines/:targetId/approve", (request, response) => void updateBaseline("approve", request, response));
app.post("/api/baselines/:targetId/restart", (request, response) => void updateBaseline("restart", request, response));

app.post("/api/test-data/clear", async (request, response) => {
  if (!requireAdmin(request, response)) return;
  const expectedRevision = Number(request.body?.expectedConfigurationRevision ?? request.body?.expectedRevision);
  if (!Number.isInteger(expectedRevision)) {
    response.status(400).json({ error: "Expected configuration revision is required" });
    return;
  }
  if (request.body?.confirmation !== "CLEAR TEST DATA") {
    response.status(400).json({ error: "Type CLEAR TEST DATA to confirm this test-only action" });
    return;
  }
  if (expectedRevision !== settingsStore.settings.revision) {
    response.status(409).json({
      error: `Settings changed since this page was opened. Reload revision ${settingsStore.settings.revision}.`,
      currentRevision: settingsStore.settings.revision,
    });
    return;
  }
  try {
    const result = await monitor.clearTestData("settings-admin");
    response.status(result.state === "complete" && result.runtimeState === "active" ? 200 : 202).json({
      configurationRevision: settingsStore.settings.revision,
      result,
    });
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/recordings/delete", async (request, response) => {
  if (!requireAdmin(request, response)) return;
  const expectedRevision = Number(request.body?.expectedConfigurationRevision ?? request.body?.expectedRevision);
  if (!Number.isInteger(expectedRevision)) {
    response.status(400).json({ error: "Expected configuration revision is required" });
    return;
  }
  if (expectedRevision !== settingsStore.settings.revision) {
    response.status(409).json({
      error: `Settings changed since this page was opened. Reload revision ${settingsStore.settings.revision}.`,
      currentRevision: settingsStore.settings.revision,
    });
    return;
  }
  if (request.body?.confirmation !== "DELETE RECORDINGS") {
    response.status(400).json({ error: "Type DELETE RECORDINGS to confirm" });
    return;
  }
  const dataDomain = request.body?.dataDomain;
  if ((dataDomain !== "field" && dataDomain !== "test") || dataDomain !== config.dataDomain) {
    response.status(409).json({ error: `Choose the active ${config.dataDomain} data domain`, dataDomain: config.dataDomain });
    return;
  }
  try {
    const audit = await settingsStore.recordOperationalAction(
      "recordings-delete",
      "settings-admin",
      clientAddress(request),
      `Authorized deletion of finalized ${dataDomain} recordings; active, finalizing, and export-leased sessions retained`,
    );
    await monitor.recordConfigurationAudit(audit);
    const result = await monitor.deleteRecordings(dataDomain, "settings-admin");
    response.status(result.state === "complete" ? 200 : result.state === "refused" ? 409 : 202).json({
      configurationRevision: settingsStore.settings.revision,
      result,
    });
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/monitor/pause", (request, response) => {
  monitor.setPaused(Boolean(request.body?.paused));
  response.json(authoritativeSnapshot().snapshot);
});

app.get("/api/receiver/recovery", async (_request, response) => {
  await refreshRecoverySupervisorState();
  response.json(currentReceiverRecoveryOperation());
});

app.post("/api/receiver/retry", async (_request, response) => {
  await refreshRecoverySupervisorState();
  const now = Date.now();
  const current = currentReceiverRecoveryOperation(now);
  const snapshot = () => compactSnapshot(authoritativeSnapshot().snapshot);
  if (current.outcome === "verified-recovery") {
    response.json({ schemaVersion: 1, recovery: current, snapshot: snapshot() });
    return;
  }
  if (current.outcome === "helper-pending") {
    response.status(202).json({ schemaVersion: 1, recovery: current, snapshot: snapshot() });
    return;
  }
  if (current.outcome === "cooldown") {
    response.status(429).setHeader("Retry-After", String(Math.max(1, Math.ceil((current.retryAfterMs ?? 30_000) / 1_000)))).json({ schemaVersion: 1, recovery: current });
    return;
  }
  if (current.outcome === "lockout") {
    response.status(423).setHeader("Retry-After", String(Math.max(1, Math.ceil((current.retryAfterMs ?? 300_000) / 1_000)))).json({ schemaVersion: 1, recovery: current });
    return;
  }
  if (receiverRecoveryStatus.availability === "available" && !receiverRecoveryStatus.fresh && receiverRecoveryStatus.status.requestRetained) {
    response.status(503).json({ schemaVersion: 1, recovery: { ...current, reasonCode: "stale-helper-status" } });
    return;
  }
  if (monitor.getSnapshot().receivers.some((receiver) => receiver.hardwareState === "absent")) {
    response.status(409).json({ schemaVersion: 1, recovery: { ...current, outcome: "unavailable", reasonCode: "hardware-absent" } });
    return;
  }
  if (now - lastRecoveryRequestAt < 30_000) {
    const retryAfterMs = 30_000 - (now - lastRecoveryRequestAt);
    response.status(202).json({
      schemaVersion: 1,
      recovery: { schemaVersion: 1, outcome: "helper-pending", reasonCode: "request-published", retryAfterMs },
      snapshot: snapshot(),
    });
    return;
  }
  try {
    const request = await publishReceiverRecoveryRequest(receiverRecoveryRequest);
    lastRecoveryRequestAt = now;
    monitor.markRecoveryRequested();
    const recovery: RecoveryOperationState = {
      schemaVersion: 1,
      outcome: "request-accepted",
      reasonCode: "request-published",
      requestId: request.requestId,
      requestedAt: request.requestedAt,
    };
    response.status(202).json({ schemaVersion: 1, recovery, snapshot: snapshot() });
  } catch (error) {
    response.status(503).json({
      schemaVersion: 1,
      recovery: { schemaVersion: 1, outcome: "unavailable", reasonCode: "request-publish-failed" },
      error: `Receiver recovery helper is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

app.get("/api/software/restart/status", async (_request, response) => {
  await refreshRecoverySupervisorState();
  response.json(currentApplicationRecoveryOperation());
});

app.post("/api/software/restart", async (request, response) => {
  if (!requireAdmin(request, response)) return;
  const expectedRevision = Number(request.body?.expectedConfigurationRevision ?? request.body?.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== settingsStore.settings.revision) {
    response.status(409).json({ error: `Settings changed since this page was opened. Reload revision ${settingsStore.settings.revision}.`, currentRevision: settingsStore.settings.revision });
    return;
  }
  if (request.body?.confirmation !== "RESTART SOFTWARE") {
    response.status(400).json({ error: "Type RESTART SOFTWARE to confirm" });
    return;
  }
  await refreshRecoverySupervisorState();
  const current = currentApplicationRecoveryOperation();
  if (current.outcome === "helper-pending" || Date.now() - lastApplicationRestartRequestAt < 30_000) {
    response.status(202).json({ schemaVersion: 1, recovery: current.outcome === "helper-pending" ? current : { schemaVersion: 1, outcome: "helper-pending", reasonCode: "request-published" } });
    return;
  }
  if (current.outcome === "cooldown" || current.outcome === "lockout") {
    response.status(current.outcome === "lockout" ? 423 : 429)
      .setHeader("Retry-After", String(Math.max(1, Math.ceil((current.retryAfterMs ?? 300_000) / 1_000))))
      .json({ schemaVersion: 1, recovery: current });
    return;
  }
  try {
    const published = await publishAuditedApplicationRestartRequest(applicationRestartRequest, {
      expectedConfigurationRevision: expectedRevision,
      previousBootId: config.runtimeIdentity.serviceBootId,
    }, async () => {
      const audit = await settingsStore.recordOperationalAction(
        "software-restart",
        "settings-admin",
        clientAddress(request),
        "Authorized application restart request prepared",
      );
      await monitor.recordConfigurationAudit(audit);
      return audit;
    });
    lastApplicationRestartRequestAt = Date.now();
    response.status(202).json({
      schemaVersion: 1,
      recovery: {
        schemaVersion: 1,
        outcome: "request-accepted",
        reasonCode: "request-published",
        requestId: published.requestId,
        requestedAt: published.requestedAt,
      },
      statusUrl: "/api/software/restart/status",
    });
  } catch (error) {
    response.status(503).json({
      schemaVersion: 1,
      recovery: { schemaVersion: 1, outcome: "unavailable", reasonCode: "audit-or-request-publish-failed" },
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/monitor/focus", async (request, response) => {
  try {
    response.json(await monitor.startFocus({
      bandId: typeof request.body?.bandId === "string" ? request.body.bandId : "",
      centerHz: request.body?.centerHz === undefined ? undefined : Number(request.body.centerHz),
      durationMs: request.body?.durationMs === undefined ? undefined : Number(request.body.durationMs),
    }));
  } catch (error) {
    response.status(422).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/monitor/focus", async (_request, response) => {
  await monitor.stopFocus();
  response.json(authoritativeSnapshot().snapshot);
});

app.post("/api/storage/maintenance", async (_request, response) => {
  response.json(await monitor.runStorageMaintenance());
});

app.post("/api/events/:eventId/acknowledge", async (request, response) => {
  const event = await monitor.acknowledgeEvent(request.params.eventId);
  if (!event) {
    response.status(404).json({ error: "Event not found" });
    return;
  }
  response.json(event);
});

app.post("/api/events/:eventId/notes", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text || text.length > 2_000) {
    response.status(400).json({ error: "Note text must contain 1 to 2,000 characters" });
    return;
  }
  try {
    const event = await monitor.addNote(request.params.eventId, text);
    if (!event) {
      response.status(404).json({ error: "Event not found" });
      return;
    }
    response.json(event);
  } catch (error) {
    response.status(422).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const screenshotRawParser = express.raw({ type: "image/png", limit: MAX_SCREENSHOT_PNG_BYTES });

function screenshotAdmissionGate(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (!request.is("image/png")) {
    response.status(415).json({ error: "Screenshot content type must be image/png", code: "SCREENSHOT_CONTENT_TYPE" });
    return;
  }
  const declared = request.headers["content-length"];
  const declaredBytes = declared === undefined ? MAX_SCREENSHOT_PNG_BYTES : Number(declared);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
    response.status(400).json({ error: "Screenshot Content-Length is invalid", code: "SCREENSHOT_LENGTH_INVALID" });
    return;
  }
  if (declaredBytes > MAX_SCREENSHOT_PNG_BYTES) {
    response.status(413).json({ error: "Screenshot exceeds the evidence writer bound", code: "SCREENSHOT_TOO_LARGE" });
    return;
  }
  if (currentResourceHealth().state !== "normal") {
    response.status(503).setHeader("Retry-After", "10").json({ error: "Screenshots are paused while monitoring resources recover", code: "SCREENSHOT_PRESSURE" });
    return;
  }
  const releaseBodySlot = screenshotBodyGate.tryAcquire();
  if (!releaseBodySlot) {
    response.status(429).setHeader("Retry-After", "2").json({ error: "Too many screenshot bodies are already in progress", code: "SCREENSHOT_IN_FLIGHT_LIMIT" });
    return;
  }
  response.locals.releaseScreenshotBodySlot = releaseBodySlot;
  response.once("finish", releaseBodySlot);
  response.once("close", releaseBodySlot);
  let eventId: string;
  try {
    eventId = boundedIdentifier(request.params.eventId);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error), code: "SCREENSHOT_EVENT_ID_INVALID" });
    return;
  }
  const admission = monitor.reserveScreenshot(eventId, declaredBytes);
  if (!admission.admitted) {
    if (admission.reason === "not-found") {
      response.status(404).json({ error: "Event or evidence session not found", code: "SCREENSHOT_EVENT_NOT_FOUND" });
      return;
    }
    if (admission.reason === "pressure") {
      response.status(503).setHeader("Retry-After", String(admission.retryAfterSeconds)).json({ error: "Screenshot evidence is under resource pressure", code: "SCREENSHOT_PRESSURE" });
      return;
    }
    response.status(429).setHeader("Retry-After", String(admission.retryAfterSeconds)).json({ error: `Screenshot ${admission.reason} quota reached`, code: `SCREENSHOT_${admission.reason.toUpperCase()}_QUOTA` });
    return;
  }
  response.locals.screenshotAdmissionLease = admission.lease;
  response.once("close", () => admission.lease.release());
  next();
}

function parseScreenshotBody(request: express.Request, response: express.Response, next: express.NextFunction): void {
  screenshotRawParser(request, response, (error) => {
    if (!error) {
      next();
      return;
    }
    const lease = response.locals.screenshotAdmissionLease as ScreenshotAdmissionLease | undefined;
    lease?.release();
    (response.locals.releaseScreenshotBodySlot as (() => void) | undefined)?.();
    const tooLarge = (error as { type?: string; status?: number }).type === "entity.too.large"
      || (error as { status?: number }).status === 413;
    response.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "Screenshot exceeds the evidence writer bound" : "Screenshot body could not be parsed",
      code: tooLarge ? "SCREENSHOT_TOO_LARGE" : "SCREENSHOT_BODY_INVALID",
    });
  });
}

app.post("/api/events/:eventId/screenshots", screenshotAdmissionGate, parseScreenshotBody, async (request, response) => {
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const lease = response.locals.screenshotAdmissionLease as ScreenshotAdmissionLease;
  try {
    const saved = await monitor.addScreenshot(boundedIdentifier(request.params.eventId), body, lease);
    if (!saved) {
      response.status(404).json({ error: "Event or evidence session not found", code: "SCREENSHOT_EVENT_NOT_FOUND" });
      return;
    }
    response.json({ saved: true });
  } catch (error) {
    lease.release();
    if (error instanceof ScreenshotPngError) {
      response.status(422).json({ error: error.message, code: error.code });
      return;
    }
    response.status(503).setHeader("Retry-After", "10").json({ error: "Screenshot evidence could not be queued", code: "SCREENSHOT_WRITE_PRESSURE" });
  }
});

app.post("/api/exports", async (request, response) => {
  if (exportBuildPressure()) {
    response.status(503).setHeader("Retry-After", "10").json({ error: "Exports are paused while RF monitoring resources recover" });
    return;
  }
  try {
    const kind = request.body?.kind;
    let job;
    if (kind === "incident") {
      job = exportQueue.submit({
        kind,
        eventId: boundedIdentifier(request.body?.eventId),
        sessionId: request.body?.sessionId === undefined ? undefined : boundedIdentifier(request.body.sessionId),
      }, { estimatedOutputBytes: incidentExportReservationBytes() });
    } else if (kind === "session") {
      job = await submitSessionExport(boundedIdentifier(request.body?.sessionId));
    } else {
      response.status(400).json({ error: "Export kind must be incident or session" });
      return;
    }
    response.status(202).json(exportResponse(job));
  } catch (error) {
    respondExportSubmissionError(response, error);
  }
});

app.get("/api/exports/:jobId", (request, response) => {
  try {
    const job = exportQueue.get(boundedIdentifier(request.params.jobId));
    if (!job) {
      response.status(404).json({ error: "Export job not found" });
      return;
    }
    response.json(exportResponse(job));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/exports/:jobId/download", async (request, response) => {
  if (currentResourceHealth().admitExports === false) {
    response.status(503).setHeader("Retry-After", "10").json({ error: "New downloads are paused while RF monitoring resources recover" });
    return;
  }
  let acquired;
  try {
    const requestedPart = request.query.part === undefined ? 1 : Number(request.query.part);
    acquired = exportQueue.tryAcquireDownload(boundedIdentifier(request.params.jobId), requestedPart);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!acquired.acquired) {
    const status = acquired.reason === "not-found" ? 404 : acquired.reason === "busy" ? 429 : acquired.reason === "invalid-part" ? 400 : 409;
    response.status(status).setHeader("Retry-After", "5").json({ error: `Export download is ${acquired.reason}` });
    return;
  }
  const { lease } = acquired;
  const filename = path.basename(lease.outputPath).replace(/[^A-Za-z0-9._-]/g, "_");
  response.status(200);
  response.setHeader("Content-Type", "application/zip");
  response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  response.setHeader("Content-Length", String(lease.sizeBytes));
  response.setHeader("Digest", `sha-256=${Buffer.from(lease.sha256, "hex").toString("base64")}`);
  response.setHeader("X-Content-SHA256", lease.sha256);
  try {
    await pipeline(createReadStream(lease.outputPath), downloadRateLimiter(), response, { signal: lease.signal });
  } catch (error) {
    if (!response.headersSent) response.status(500).json({ error: `Download failed: ${String(error)}` });
  } finally {
    lease.release();
  }
});

async function sendIncidentFigure(request: express.Request, response: express.Response, kind: "svg" | "png" | "analysis"): Promise<void> {
  const format = kind === "png" ? "png" : "svg";
  try {
    const figure = await monitor.getIncidentFigure(boundedIdentifier(request.params.eventId), kind);
    if (!figure) {
      response.status(404).json({ error: "No saved image exists for this incident yet" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // The image is data only. Nothing in it may run script or load anything else.
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    response.setHeader("Content-Disposition", `inline; filename="incident-${boundedIdentifier(request.params.eventId)}-${figure.stamp}${kind === "analysis" ? "-analysis" : ""}.${format}"`);
    response.type(format === "svg" ? "image/svg+xml" : "image/png").send(figure.bytes);
  } catch {
    response.status(400).json({ error: "The incident image could not be read" });
  }
}

app.get("/api/events/:eventId/figure.:format", async (request, response) => {
  const format = request.params.format;
  if (format !== "svg" && format !== "png") {
    response.status(404).json({ error: "Unknown image format" });
    return;
  }
  await sendIncidentFigure(request, response, format);
});

app.get("/api/events/:eventId/analysis.svg", (request, response) => void sendIncidentFigure(request, response, "analysis"));

app.get("/api/events/:eventId/export", (request, response) => {
  if (exportBuildPressure()) {
    response.status(503).setHeader("Retry-After", "10").json({ error: "Exports are paused while RF monitoring resources recover" });
    return;
  }
  try {
    const job = exportQueue.submit({
      kind: "incident",
      eventId: boundedIdentifier(request.params.eventId),
      sessionId: typeof request.query.sessionId === "string" ? boundedIdentifier(request.query.sessionId) : undefined,
    }, { estimatedOutputBytes: incidentExportReservationBytes() });
    response.status(202).json({ ...exportResponse(job), compatibility: "legacy-create-route" });
  } catch (error) {
    respondExportSubmissionError(response, error);
  }
});

app.get("/api/evidence/archive", async (request, response) => {
  const offset = typeof request.query.offset === "string" ? Number(request.query.offset) : 0;
  const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : 20;
  const eventOffset = typeof request.query.eventOffset === "string" ? Number(request.query.eventOffset) : 0;
  const eventLimit = typeof request.query.eventLimit === "string" ? Number(request.query.eventLimit) : 5;
  response.json(await monitor.getEvidenceArchive(
    Number.isFinite(offset) ? offset : 0,
    Number.isFinite(limit) ? limit : 20,
    Number.isFinite(eventOffset) ? eventOffset : 0,
    Number.isFinite(eventLimit) ? eventLimit : 5,
  ));
});

app.get("/api/evidence/sessions/:sessionId/events", async (request, response) => {
  let sessionId: string;
  try {
    sessionId = boundedIdentifier(request.params.sessionId);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const offset = typeof request.query.offset === "string" ? Number(request.query.offset) : 0;
  const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : 20;
  const page = await monitor.getEvidenceSessionEvents(
    sessionId,
    Number.isFinite(offset) ? offset : 0,
    Number.isFinite(limit) ? limit : 20,
  );
  if (!page) {
    response.status(404).json({ error: "Evidence session not found" });
    return;
  }
  response.json(page);
});

app.get("/api/evidence/sessions/:sessionId/replay", async (request, response) => {
  try {
    const sessionId = boundedIdentifier(request.params.sessionId);
    const cursor = typeof request.query.cursor === "string" ? request.query.cursor : undefined;
    const requestedLimit = typeof request.query.limit === "string" ? Number(request.query.limit) : 12;
    response.setHeader("Cache-Control", "no-store");
    response.json(await evidencePlayback.readBatch(
      sessionId,
      cursor,
      Number.isFinite(requestedLimit) ? requestedLimit : 12,
    ));
  } catch (error) {
    if (error instanceof EvidencePlaybackError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    response.status(409).json({
      error: "Evidence replay source could not be read safely",
      code: "EVIDENCE_REPLAY_SOURCE_INVALID",
    });
  }
});

app.get("/api/evidence/sessions/:sessionId/export", async (request, response) => {
  if (exportBuildPressure()) {
    response.status(503).setHeader("Retry-After", "10").json({ error: "Exports are paused while RF monitoring resources recover" });
    return;
  }
  try {
    const job = await submitSessionExport(boundedIdentifier(request.params.sessionId));
    response.status(202).json({ ...exportResponse(job), compatibility: "legacy-create-route" });
  } catch (error) {
    respondExportSubmissionError(response, error);
  }
});

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledClientDirectory = path.resolve(moduleDirectory, "../client");
const clientDirectory = existsSync(path.join(bundledClientDirectory, "index.html"))
  ? bundledClientDirectory
  : path.resolve(process.cwd(), "dist/client");
if (existsSync(path.join(clientDirectory, "index.html"))) {
  app.use(express.static(clientDirectory, { maxAge: "1h", index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api") || request.path === "/live") {
      next();
      return;
    }
    response.sendFile(path.join(clientDirectory, "index.html"));
  });
}

const server = createServer(app);
const liveServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 16 * 1024,
});

interface LiveClientState {
  id: string;
  connectedAt: number;
  subscription: NormalizedLiveSubscription;
  subscriptionSignature: string;
  lastFrameAt: number;
  pendingFrames: Map<string, Extract<ServiceMessage, { type: "frame" }>>;
  pendingTimer?: NodeJS.Timeout;
  controlTimer?: NodeJS.Timeout;
  controlQueue: LatestLiveControlQueue;
  alive: boolean;
  budget: TokenBucket;
  pressureSince?: number;
  pendingFrameBytes: number;
  bootstrapConfigurationHash: string;
  lastDeliveredFrameAt?: number;
}

const liveClients = new Map<WebSocket, LiveClientState>();

function visibleTargetIds(subscription: NormalizedLiveSubscription): string[] {
  return subscription.visibleTargetIds;
}

function detailTargetIds(subscription: NormalizedLiveSubscription): string[] {
  return subscription.detailTargetIds;
}

function visibleFeedIds(subscription: NormalizedLiveSubscription): string[] {
  return subscription.visibleFeedIds;
}

function detailFeedIds(subscription: NormalizedLiveSubscription): string[] {
  return subscription.detailFeedIds;
}

function sendTracked(socket: WebSocket, payload: string | Uint8Array): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const state = liveClients.get(socket);
  const now = Date.now();
  const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
  streamingCounters.maxBufferedBytes = Math.max(streamingCounters.maxBufferedBytes, socket.bufferedAmount);
  if (bytes > CLIENT_CLOSE_BYTES || socket.bufferedAmount + bytes > CLIENT_CLOSE_BYTES || (state?.pressureSince && now - state.pressureSince >= 10_000)) {
    streamingCounters.slowClientDrops += 1;
    socket.close(1013, "Live client cannot keep up");
    return false;
  }
  if (socket.bufferedAmount > CLIENT_PRESSURE_BYTES) {
    if (state && !state.pressureSince) state.pressureSince = now;
    streamingCounters.slowClientDrops += 1;
    return false;
  }
  if (state) state.pressureSince = undefined;
  if ((state && !state.budget.take(bytes, now)) || !globalLiveBudget.take(bytes, now)) {
    streamingCounters.budgetDrops += 1;
    return false;
  }
  streamingCounters.outboundBytes += bytes;
  outboundTraffic.addLive(bytes, now);
  socket.send(payload);
  return true;
}

function sendControl(socket: WebSocket, message: Exclude<ServiceMessage, { type: "frame" }>): boolean {
  const payload = JSON.stringify(message);
  if (Buffer.byteLength(payload) > MAX_CONTROL_STATE_BYTES) {
    streamingCounters.budgetDrops += 1;
    socket.close(1011, "Control state exceeded its resource bound");
    return false;
  }
  return sendTracked(socket, payload);
}

function closeForControlFailure(socket: WebSocket, state: LiveClientState, reason: string): void {
  if (state.controlTimer) clearTimeout(state.controlTimer);
  state.controlTimer = undefined;
  state.controlQueue.clear();
  if (socket.readyState === WebSocket.OPEN) socket.close(1013, reason.slice(0, 120));
}

function scheduleStateControl(socket: WebSocket, state: LiveClientState): void {
  if (state.controlTimer || !state.controlQueue.hasPending || socket.readyState !== WebSocket.OPEN) return;
  state.controlTimer = setTimeout(() => {
    state.controlTimer = undefined;
    flushStateControl(socket, state);
  }, 100);
  state.controlTimer.unref();
}

function flushStateControl(socket: WebSocket, state: LiveClientState): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const result = state.controlQueue.drain(Date.now(), (payload) => sendTracked(socket, payload));
  if (result.state === "close") {
    closeForControlFailure(socket, state, result.reason);
    return;
  }
  if (result.state === "retry") {
    scheduleStateControl(socket, state);
    return;
  }
  if (result.state === "delivered") {
    if (state.controlTimer) clearTimeout(state.controlTimer);
    state.controlTimer = undefined;
    schedulePendingFrame(socket, state);
  }
}

function queueStateDelta(socket: WebSocket, message: Extract<ServiceMessage, { type: "state-delta" }>): void {
  const state = liveClients.get(socket);
  if (!state || socket.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(message);
  const payloadBytes = Buffer.byteLength(payload);
  if (socket.bufferedAmount + state.pendingFrameBytes + payloadBytes > CLIENT_CLOSE_BYTES) {
    closeForControlFailure(socket, state, "Live control queue exceeded its resource bound");
    return;
  }
  const queued = state.controlQueue.enqueue(payload, message.payload.operatorSummary.monitoring.state, Date.now());
  if (queued.state === "close") {
    closeForControlFailure(socket, state, queued.reason);
    return;
  }
  // State has priority over spectrum. Frames remain latest-only while the
  // bounded control slot waits for transport and token capacity.
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingTimer = undefined;
  flushStateControl(socket, state);
}

function sendFrame(socket: WebSocket, state: LiveClientState, message: Extract<ServiceMessage, { type: "frame" }>): void {
  try {
    const binary = encodeSpectrumEnvelope(message.payload.frame, message.payload.metrics, message.payload.event, message.payload.targetState, message.payload.feedId);
    state.lastFrameAt = Date.now();
    if (sendTracked(socket, binary)) {
      streamingCounters.spectrumMessages += 1;
      state.lastDeliveredFrameAt = Date.now();
    }
  } catch {
    streamingCounters.budgetDrops += 1;
  }
}

const pendingFrameByteEstimates = new WeakMap<object, number>();

/**
 * Bytes a queued frame is charged against the per-client budget. The estimate
 * is requested at enqueue, dequeue and drop for the same message object, so it
 * is computed once per message rather than serialising the metadata each time.
 */
function estimatePendingFrameBytes(message: Extract<ServiceMessage, { type: "frame" }>): number {
  const cached = pendingFrameByteEstimates.get(message);
  if (cached !== undefined) return cached;
  const { bins, ...frame } = message.payload.frame;
  const bytes = bins.byteLength + 6 + Buffer.byteLength(JSON.stringify({
    frame,
    metrics: message.payload.metrics,
    event: message.payload.event,
    targetState: message.payload.targetState,
    feedId: message.payload.feedId,
  }));
  pendingFrameByteEstimates.set(message, bytes);
  return bytes;
}

function schedulePendingFrame(socket: WebSocket, state: LiveClientState): void {
  if (state.pendingTimer || !state.pendingFrames.size || state.controlQueue.hasPending) return;
  const requestedRate = state.subscription.rateHz;
  const effectiveRate = Math.min(currentResourceHealth().maxDashboardRateHz ?? 4, requestedRate);
  const intervalMs = 1_000 / effectiveRate;
  const delay = Math.max(0, intervalMs - (Date.now() - state.lastFrameAt));
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = undefined;
    const preferred = detailTargetIds(state.subscription)
      .concat(detailFeedIds(state.subscription))
      .map((streamId) => [streamId, state.pendingFrames.get(streamId)] as const)
      .find((entry) => Boolean(entry[1]));
    const next = (preferred ?? state.pendingFrames.entries().next().value) as [string, Extract<ServiceMessage, { type: "frame" }>] | undefined;
    if (!next) return;
    state.pendingFrames.delete(next[0]);
    state.pendingFrameBytes = Math.max(0, state.pendingFrameBytes - estimatePendingFrameBytes(next[1]));
    if (socket.readyState === WebSocket.OPEN) sendFrame(socket, state, next[1]);
    schedulePendingFrame(socket, state);
  }, delay);
  state.pendingTimer.unref();
}

function queueFrame(socket: WebSocket, message: Extract<ServiceMessage, { type: "frame" }>): void {
  const state = liveClients.get(socket);
  if (!state) return;
  if (currentResourceHealth().dashboardsStatusOnly) {
    state.pendingFrames.clear();
    state.pendingFrameBytes = 0;
    return;
  }
  const streamId = message.payload.feedId
    ?? message.payload.frame.targetId
    ?? message.payload.frame.scanWindowId
    ?? message.payload.frame.bandId;
  const visible = message.payload.feedId ? visibleFeedIds(state.subscription) : visibleTargetIds(state.subscription);
  if (!visible.length || !visible.includes(streamId)) return;
  const previous = state.pendingFrames.get(streamId);
  if (previous) {
    state.pendingFrameBytes = Math.max(0, state.pendingFrameBytes - estimatePendingFrameBytes(previous));
    streamingCounters.coalescedFrames += 1;
  }
  const estimatedBytes = estimatePendingFrameBytes(message);
  if (!previous && state.pendingFrameBytes + estimatedBytes > CLIENT_PRESSURE_BYTES) {
    streamingCounters.slowClientDrops += 1;
    return;
  }
  state.pendingFrames.set(streamId, message);
  state.pendingFrameBytes += estimatedBytes;
  schedulePendingFrame(socket, state);
}

server.on("upgrade", (request, socket, head) => {
  guardUpgradeSocket(socket, reportSocketFault);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/live" || !originAllowed(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (liveServer.clients.size >= MAX_LIVE_CLIENTS) {
    streamingCounters.rejectedClients += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (currentResourceHealth().admitLiveClients === false) {
    streamingCounters.rejectedClients += 1;
    socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 10\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  liveServer.handleUpgrade(request, socket, head, (websocket) => liveServer.emit("connection", websocket, request));
});

liveServer.on("connection", (socket) => {
  guardWebSocket(socket, reportSocketFault);
  const initialSubscription = normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 2, engineer: false })!;
  const bootstrap = compactSnapshot(authoritativeSnapshot().snapshot);
  const state: LiveClientState = {
    id: `dashboard-${++liveClientSequence}`,
    connectedAt: Date.now(),
    subscription: initialSubscription,
    subscriptionSignature: liveSubscriptionSignature(initialSubscription),
    lastFrameAt: 0,
    pendingFrames: new Map(),
    controlQueue: new LatestLiveControlQueue(MAX_CONTROL_STATE_BYTES),
    alive: true,
    budget: new TokenBucket(64 * 1024, 128 * 1024),
    pendingFrameBytes: 0,
    bootstrapConfigurationHash: bootstrap.configuration.configurationHash,
  };
  liveClients.set(socket, state);
  if (!sendControl(socket, { type: "snapshot", controlSequence: nextLiveControlSequence(), payload: bootstrap })) socket.close(1013, "Bootstrap unavailable");
  else state.controlQueue.markDeliveredState(bootstrap.operatorSummary.monitoring.state);
  socket.on("pong", () => { state.alive = true; });
  socket.on("message", (data, binary) => {
    if (binary) return;
    try {
      const incoming = JSON.parse(data.toString()) as Partial<LiveSubscription>;
      const currentSnapshot = authoritativeSnapshot().snapshot;
      const validTargets = new Set(currentSnapshot.monitorTargets.map((target) => target.id));
      const validFeeds = new Set(currentSnapshot.monitorFeeds.filter((feed) => feed.kind === "stitched-sweep").map((feed) => feed.id));
      const normalized = normalizeLiveSubscription(incoming, validTargets, validFeeds);
      if (!normalized) {
        socket.close(1008, "Invalid live-stream subscription");
        return;
      }
      const signature = liveSubscriptionSignature(normalized);
      if (signature === state.subscriptionSignature) {
        streamingCounters.duplicateSubscriptions += 1;
        return;
      }
      const previouslyVisible = new Set(state.subscription.visibleTargetIds);
      const previouslyVisibleFeeds = new Set(state.subscription.visibleFeedIds);
      state.subscription = normalized;
      state.subscriptionSignature = signature;
      const rate = normalized.rateHz === 0.2 ? 16 * 1024 : normalized.engineer ? 128 * 1024 : 64 * 1024;
      state.budget.configure(rate, rate * 2);
      for (const targetId of state.pendingFrames.keys()) {
        if (!normalized.visibleTargetIds.includes(targetId) && !normalized.visibleFeedIds.includes(targetId)) {
          const pending = state.pendingFrames.get(targetId);
          if (pending) state.pendingFrameBytes = Math.max(0, state.pendingFrameBytes - estimatePendingFrameBytes(pending));
          state.pendingFrames.delete(targetId);
        }
      }
      sendControl(socket, { type: "subscription-ack", payload: normalized });
      const newlyVisible = normalized.visibleTargetIds.filter((targetId) => !previouslyVisible.has(targetId));
      const newlyVisibleFeeds = normalized.visibleFeedIds.filter((feedId) => !previouslyVisibleFeeds.has(feedId));
      const initialTargets = [
        ...normalized.detailTargetIds.filter((targetId) => newlyVisible.includes(targetId)),
        ...newlyVisible.filter((targetId) => !normalized.detailTargetIds.includes(targetId)),
      ];
      if (initialTargets.length) for (const frame of monitor.getTargetFrames(initialTargets)) queueFrame(socket, frame);
      if (newlyVisibleFeeds.length) for (const frame of monitor.getSweepFrames(newlyVisibleFeeds)) queueFrame(socket, frame);
    } catch {
      sendControl(socket, { type: "error", payload: { message: "Invalid live-stream subscription" } });
    }
  });
  socket.on("close", () => {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    if (state.controlTimer) clearTimeout(state.controlTimer);
    state.controlQueue.clear();
    state.pendingFrames.clear();
    state.pendingFrameBytes = 0;
    liveClients.delete(socket);
  });
});

monitor.on("message", (message: ServiceMessage) => {
  const authoritativeMessage: ServiceMessage = message.type === "snapshot"
    ? { type: "snapshot", payload: authoritativeSnapshot(message.payload).snapshot }
    : message;
  const controlSequence = authoritativeMessage.type === "snapshot"
    ? nextLiveControlSequence()
    : undefined;
  for (const client of liveServer.clients) {
    if (authoritativeMessage.type === "frame") {
      queueFrame(client, authoritativeMessage);
      continue;
    }
    const state = liveClients.get(client);
    if (!state) continue;
    if (authoritativeMessage.type === "snapshot") {
      if (authoritativeMessage.payload.configuration.configurationHash !== state.bootstrapConfigurationHash) {
        const bootstrap = compactSnapshot(authoritativeMessage.payload, state.subscription.engineer);
        if (sendControl(client, { type: "snapshot", controlSequence, payload: bootstrap })) {
          state.bootstrapConfigurationHash = bootstrap.configuration.configurationHash;
          state.controlQueue.markDeliveredState(bootstrap.operatorSummary.monitoring.state);
        } else {
          closeForControlFailure(client, state, "Updated live state could not be delivered");
        }
      } else {
        queueStateDelta(client, { type: "state-delta", controlSequence, payload: compactStateDelta(authoritativeMessage.payload, state.subscription.engineer) });
      }
      continue;
    }
    sendControl(client, authoritativeMessage);
  }
});

const heartbeatTimer = setInterval(() => {
  // Protocol v2 freshness is tied to server-owned canonical state, not to
  // spectrum traffic or a transport-only heartbeat. Publish one bounded,
  // bins-free state delta every heartbeat interval even when nothing changed,
  // so a healthy live browser never drifts into Data late while frames flow.
  const freshSnapshot = authoritativeSnapshot().snapshot;
  const controlSequence = nextLiveControlSequence();
  const heartbeat = { type: "heartbeat", payload: {
    generatedAt: freshSnapshot.generatedAt,
    monitoringReady: freshSnapshot.monitoringReady,
    clients: liveServer.clients.size,
  } } satisfies Extract<ServiceMessage, { type: "heartbeat" }>;
  for (const [client, state] of liveClients) {
    if (!state.alive) {
      client.terminate();
      continue;
    }
    state.alive = false;
    client.ping();
    if (state.subscription.protocolVersion === 2) {
      queueStateDelta(client, {
        type: "state-delta",
        controlSequence,
        payload: compactStateDelta(freshSnapshot, state.subscription.engineer),
      });
    } else {
      // One-release protocol-v1 compatibility path.
      sendControl(client, heartbeat);
    }
  }
}, LIVE_HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

await monitor.start();
await monitor.recordConfigurationAudit(await settingsStore.recentAudit());
await diagnosticsCollector.start();
await refreshRecoverySupervisorState();
const recoveryStatusTimer = setInterval(() => void refreshRecoverySupervisorState(), 2_000);
recoveryStatusTimer.unref();
server.listen(config.port, config.host, () => {
  console.log(`RF Monitor service listening on http://${config.host}:${config.port}`);
  console.log(`Evidence archive: ${config.storageRoot}`);
});

let lastSocketFaultLogAt = 0;
function reportSocketFault(error: Error): void {
  const now = Date.now();
  if (now - lastSocketFaultLogAt < 10_000) return;
  lastSocketFaultLogAt = now;
  console.warn(`Live socket fault closed: ${error.message}`);
}

let serverClosed: Promise<void> = Promise.resolve();
const shutdown = createShutdownCoordinator({
  log: (message) => console.log(message),
  exit: (code) => process.exit(code),
  steps: [
    {
      name: "stop accepting connections",
      run: () => {
        serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        clearInterval(heartbeatTimer);
        clearInterval(eventLoopSampleTimer);
        clearInterval(recoveryStatusTimer);
        diagnosticsCollector.stop();
        eventLoopHistogram.disable();
        for (const client of liveServer.clients) client.terminate();
        liveServer.close();
        server.closeIdleConnections();
      },
    },
    { name: "flush production qualification", run: () => productionQualificationStore.flush() },
    { name: "flush stability incidents", run: () => stabilityIncidents.flush() },
    // Closes the evidence session and releases the data-domain lease; must always be reached.
    { name: "stop monitor", run: () => monitor.stop() },
    // Evidence is safe by now; anything still open (a long download) is cut rather than waited for.
    { name: "close remaining connections", run: () => server.closeAllConnections() },
    { name: "wait for server close", run: () => serverClosed },
  ],
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// An unexpected fault still ends the process (systemd restarts it), but evidence is closed first.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  void shutdown("unhandledRejection", 1);
});
