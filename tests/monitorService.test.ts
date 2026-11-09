import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, withOperationalSettings } from "../src/server/config";
import { clearTestDomain, ensureDomainRoot } from "../src/server/dataDomains";
import type { VisitRecord } from "../src/server/deadlineScheduler";
import { BaselineApprovalUnavailableError, MonitorService, reduceSpectrumBins } from "../src/server/monitorService";
import { DEVELOPMENT_QUALIFICATION_WINDOW_MS } from "../src/server/productionQualification";
import type { ExpectedSdrconnectFrameEpoch, SdrconnectSpectrumPayload } from "../src/server/sdrconnectClient";
import { applyMonitoringMission } from "../src/shared/settings";
import type { BaselineDescriptor, ChannelMonitorState, DetectionEvent } from "../src/shared/types";

vi.mock("../src/server/usbPresence", () => ({ detectSdrplayUsb: vi.fn().mockResolvedValue("present") }));

const TIER_ONE_TARGETS_IDS = new Set([
  "gnss-l1-e1-b1c-sbas",
  "gnss-gps-l2c",
  "gnss-l5-e5a-b2a",
  "gnss-glonass-g1",
]);

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryConfig(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `rf-monitor-${name}-`));
  temporaryRoots.push(root);
  const config = await loadConfig({ RF_MONITOR_STORAGE: root, RF_MONITOR_SIMULATION: "on" });
  config.settingsPaths.operational = path.join(root, "operational.json");
  config.settingsPaths.audit = path.join(root, "config-audit.jsonl");
  config.settingsPaths.revisions = path.join(root, "revisions");
  return config;
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      hash.update(path.relative(root, absolute));
      if (entry.isDirectory()) await walk(absolute);
      else hash.update(await readFile(absolute));
    }
  };
  await walk(root);
  return hash.digest("hex");
}

function enableSingleRadioTarget(base: Awaited<ReturnType<typeof loadConfig>>) {
  const settings = structuredClone(base.operationalSettings);
  settings.scan.profile = "balanced";
  settings.monitoring.gnss.enabled = false;
  settings.monitoring.gnss.enabledSignalIds = [];
  settings.monitoring.gnss.enabledSystemIds = [];
  for (const group of Object.values(settings.monitoring.gnss.constellations)) {
    group.enabled = false;
    for (const signal of Object.values(group.signals)) signal.enabled = false;
  }
  settings.monitoring.startrack.enabled = true;
  settings.monitoring.startrack.channels = { mode: "frequencies", frequenciesHz: [410_000_000] };
  settings.monitoring["4dx"].enabled = false;
  return withOperationalSettings(base, settings);
}

// Continuous Watch on the one Fugro capture window. The mission helper also
// seeds a beam selection, which an enabled-but-empty Fugro service would not.
function enableFugroTarget(base: Awaited<ReturnType<typeof loadConfig>>) {
  const settings = applyMonitoringMission(base.operationalSettings, base.bandCatalog, "continuous-watch", "fugro-corrections-lband");
  return withOperationalSettings(base, settings);
}

describe("bounded monitor runtime", () => {
  it("publishes one server-owned operator summary without treating simulation as production", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const monitor = new MonitorService(await temporaryConfig("operator-summary"));
    await monitor.start();

    const snapshot = monitor.getSnapshot();
    expect(snapshot.operatorSummary).toMatchObject({
      generatedAt: snapshot.generatedAt,
      serverBuildId: snapshot.identity.release.serverBuildId,
      dataMode: "simulation",
      monitoring: { state: "checking", reasonCode: "signal-learning" },
      currentHealth: { state: "simulation" },
      recording: { state: "recording" },
      productionQualification: { state: "simulation", ready: false },
      observation: { at: null, coverage: "unknown" },
    });
    expect(snapshot.operatorStatus).toBe("Checking");
    expect(monitor.getCommissioningHealth().soakRequiredMs).toBe(DEVELOPMENT_QUALIFICATION_WINDOW_MS);
    await monitor.stop();
  });

  it("attributes the canonical operator clock to the affected target, not the newest unrelated visit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    const base = await temporaryConfig("operator-observation-target");
    const multiBand = applyMonitoringMission(base.operationalSettings, base.bandCatalog, "gnss-survey");
    const monitor = new MonitorService(withOperationalSettings(base, multiBand));
    await monitor.start();
    const targets = monitor.getSnapshot().monitorTargets;
    expect(targets.length).toBeGreaterThanOrEqual(2);
    const affected = targets[0];
    const unrelated = targets[1];
    const affectedAt = "2026-08-23T11:59:55.000Z";
    const unrelatedAt = "2026-08-23T11:59:59.000Z";
    const internal = monitor as unknown as {
      targetStates: Map<string, ChannelMonitorState>;
      activeEventsByTarget: Map<string, DetectionEvent>;
    };
    internal.targetStates.set(affected.id, {
      targetId: affected.id,
      lifecycle: "detecting",
      candidateCount: 0,
      clearCount: 0,
      requiredCount: 3,
      lastObservedAt: affectedAt,
    });
    internal.targetStates.set(unrelated.id, {
      targetId: unrelated.id,
      lifecycle: "clear",
      candidateCount: 0,
      clearCount: 0,
      requiredCount: 3,
      lastObservedAt: unrelatedAt,
    });

    expect(monitor.getSnapshot().operatorSummary).toMatchObject({
      affectedTargets: [],
      observation: { at: unrelatedAt, targetId: unrelated.id },
    });
    internal.targetStates.set(affected.id, {
      ...internal.targetStates.get(affected.id)!,
      candidateCount: 1,
    });

    expect(monitor.getSnapshot().operatorSummary.observation).toMatchObject({
      at: affectedAt,
      targetId: affected.id,
    });

    const eventAt = "2026-08-23T11:59:54.000Z";
    internal.targetStates.set(unrelated.id, {
      ...internal.targetStates.get(unrelated.id)!,
      lifecycle: "active",
      lastObservedAt: eventAt,
    });
    internal.activeEventsByTarget.set(unrelated.id, {
      id: "operator-target-attribution",
      dataDomain: "test",
      sessionId: "synthetic:operator-target-attribution",
      sessionIds: [],
      targetId: unrelated.id,
      kind: "gnss-energy-anomaly",
      status: "suspicious",
      severity: "medium",
      evidenceStrength: "Medium",
      evidenceBasis: "Repeated relative RF-energy anomaly.",
      baselineFingerprintId: "a".repeat(64),
      ruleSetId: "rf-relative-mad-v1",
      observationId: "observation-1",
      service: "gnss",
      bandId: unrelated.relatedBandIds[0] ?? unrelated.id,
      bandLabel: unrelated.label,
      affectedRangeHz: [unrelated.startHz, unrelated.endHz],
      observed: "Relative RF energy stayed above normal.",
      recommendedAction: "Compare approved navigation sources.",
      startedAt: eventAt,
      lastSeenAt: eventAt,
      lifecycle: "active",
      notes: [],
      metrics: {
        timestamp: eventAt,
        bandId: unrelated.relatedBandIds[0] ?? unrelated.id,
        meanLevel: 8,
        peakLevel: 12,
        baselineLevel: 3,
        baselineDelta: 5,
        occupiedRatio: 0.6,
        overload: false,
      },
    });

    expect(monitor.getSnapshot().operatorSummary.observation).toMatchObject({
      at: eventAt,
      targetId: unrelated.id,
    });
    await monitor.stop();
  });

  it("keeps reduced spectrum packed while preserving narrow peaks", () => {
    const reduced = reduceSpectrumBins(Uint8Array.from([1, 90, 3, 4, 5, 120, 7, 8]), 4);
    expect(reduced).toBeInstanceOf(Uint8Array);
    expect(Array.from(reduced)).toEqual([90, 4, 120, 8]);
  });

  it("rolls evidence sessions on reconfiguration and bounds exclusive focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("runtime");
    const monitor = new MonitorService(config);
    await monitor.start();
    const firstSession = monitor.getSnapshot().sessions[0].id;

    const focus = await monitor.startFocus({ bandId: "startrack-410-470", centerHz: 410_025_000, durationMs: 60_000 });
    const focused = monitor.getSnapshot();
    expect(focused.activeFocus).toMatchObject({ id: focus.id, centerHz: 410_025_000 });
    expect(focused.monitorTargets.every((target) => target.coverageMode === "paused")).toBe(true);
    expect(focused.sweepCycles.every((cycle) => cycle.status === "paused")).toBe(true);
    vi.setSystemTime(new Date("2026-08-20T12:01:01.000Z"));
    expect(monitor.getSnapshot().activeFocus).toBeUndefined();

    const settings = structuredClone(config.operationalSettings);
    settings.revision += 1;
    settings.siteName = "Reconfigured site";
    const nextConfig = withOperationalSettings(config, settings);
    await monitor.reconfigure(nextConfig);
    const snapshot = monitor.getSnapshot();
    expect(snapshot.siteName).toBe("Reconfigured site");
    expect(snapshot.configuration.revision).toBe(2);
    expect(snapshot.sessions[0].id).not.toBe(firstSession);
    expect(snapshot.sessions.some((session) => session.id === firstSession && session.status === "closed")).toBe(true);
    expect(monitor.getSchedulerHealth().activeVisit).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.getSchedulerHealth().completedVisits).toBeGreaterThan(0);
    await monitor.stop();
  });

  it("drains queued old-session evidence before a settings reconfiguration closes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("reconfigure-evidence-drain");
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      evidence: {
        currentSession?: { path: string };
        recordMetadata(receiver: number, metadata: object): Promise<void>;
        enqueue<T>(operation: () => Promise<T>, estimatedBytes: number, priority: "high" | "normal" | "low"): Promise<T>;
      };
    };
    const oldSessionPath = internal.evidence.currentSession!.path;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const activeWrite = internal.evidence.enqueue(() => blocked, 1, "low");
    const metadataWrites = Array.from({ length: 20 }, (_, index) => internal.evidence.recordMetadata(0, {
      property: "test-state",
      value: index,
    }));

    const settings = structuredClone(config.operationalSettings);
    settings.revision += 1;
    settings.siteName = "Queued evidence reconfiguration";
    let applied = false;
    const applying = monitor.reconfigure(withOperationalSettings(config, settings)).then((snapshot) => {
      applied = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(applied).toBe(false);

    release();
    await Promise.all([activeWrite, ...metadataWrites]);
    const snapshot = await applying;
    expect(snapshot.evidenceHealthy).toBe(true);
    expect(monitor.getWriterHealth()).toMatchObject({ queueItems: 0, queueBytes: 0 });
    const metadata = await readFile(path.join(oldSessionPath, "sdrconnect-events.jsonl"), "utf8");
    expect(metadata.trim().split("\n")).toHaveLength(20);
    await monitor.stop();
  });

  it("runs the fast Tier-1 physical-target sequence and exposes deadline health", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("deadline");
    const multiBand = applyMonitoringMission(base.operationalSettings, base.bandCatalog, "gnss-survey");
    const monitor = new MonitorService(withOperationalSettings(base, multiBand));
    await monitor.start();

    expect(monitor.getSnapshot().receivers[0].activeWindowId).toBe("gnss-l1-e1-b1c-sbas");
    await vi.advanceTimersByTimeAsync(800);
    expect(monitor.getSnapshot().receivers[0].activeWindowId).toBe("gnss-gps-l2c");
    await vi.advanceTimersByTimeAsync(800);
    expect(monitor.getSnapshot().receivers[0].activeWindowId).toBe("gnss-l1-e1-b1c-sbas");
    await vi.advanceTimersByTimeAsync(3_200);
    const health = monitor.getSchedulerHealth();
    expect(health).toMatchObject({
      profile: "fast-gnss",
      currentCoverage: { state: "checking", windowMs: 60_000 },
      optionalQualificationReady: true,
      optionalWorkAdmitted: false,
      protectedReserveRatio: 0.1,
    });
    expect(health.completedVisits).toBeGreaterThan(3);
    expect(health.missedObjectives).toBe(0);
    const timing = monitor.getTargetTimingHealth().filter((target) => target.completedVisits > 0);
    expect(timing.length).toBeGreaterThanOrEqual(3);
    // Startup phasing is not an RF observation. Every target needs its own
    // second real completion before one revisit sample exists.
    expect(timing.every((target) => target.revisitMs.samples === Math.max(0, target.completedVisits - 1))).toBe(true);
    expect(health.tier1MeetingObjective).toBeUndefined();
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(false);
    await vi.advanceTimersByTimeAsync(7_200);
    const tierOneTiming = monitor.getTargetTimingHealth().filter((target) => TIER_ONE_TARGETS_IDS.has(target.targetId));
    expect(tierOneTiming).toHaveLength(4);
    expect(tierOneTiming.every((target) => target.revisitMs.samples > 0)).toBe(true);
    expect(monitor.getSchedulerHealth()).toMatchObject({
      tier1MeetingObjective: true,
      currentCoverage: { state: "on-time", windowMs: 60_000 },
    });
    // Scheduler history is useful immediately, but qualification cadence does
    // not start until the bounded preparation window ends.
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(false);
    const internal = monitor as unknown as {
      commissioningStartedAtMonotonicMs: number;
      commissioningStartedAtWallMs: number;
      stopSimulation(): void;
      commissioningLastValidCompletionByTarget: Map<string, number>;
      commissioningValidRevisitsByTarget: Map<string, number>;
      commissioningOnTimeRevisitsByTarget: Map<string, number>;
    };
    internal.commissioningStartedAtMonotonicMs = performance.now();
    internal.commissioningStartedAtWallMs = Date.now();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(true);
    internal.stopSimulation();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(monitor.getSchedulerHealth().currentCoverage).toMatchObject({
      state: "late",
      targetId: expect.stringMatching(/^gnss-/),
    });
    await monitor.stop();
  });

  it("scores qualification cadence only after warm-up and anchors its first valid completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const monitor = new MonitorService(await temporaryConfig("qualification-cadence-boundary"));
    const internal = monitor as unknown as {
      commissioningStartedAtMonotonicMs: number;
      commissioningFaults: Set<string>;
      commissioningLastValidCompletionByTarget: Map<string, number>;
      commissioningValidRevisitsByTarget: Map<string, number>;
      commissioningOnTimeRevisitsByTarget: Map<string, number>;
      recordCommissioningTimingCompletion: (completion: VisitRecord) => void;
    };
    const completion = (completedAtMs: number, overrides: Partial<VisitRecord> = {}): VisitRecord => ({
      sequence: completedAtMs,
      targetId: "gnss-l1-e1-b1c-sbas",
      tier: "tier1",
      startedAtMs: completedAtMs - 100,
      completedAtMs,
      durationMs: 100,
      observedExposureMs: 100,
      valid: true,
      completionCause: "valid-observation",
      revisitObjectiveMs: 500,
      deadlineAtStartMs: completedAtMs,
      missedObjective: false,
      missByMs: 0,
      ...overrides,
    });

    internal.commissioningStartedAtMonotonicMs = 1_500;
    internal.recordCommissioningTimingCompletion(completion(1_000));
    expect(internal.commissioningLastValidCompletionByTarget.size).toBe(0);

    internal.commissioningStartedAtMonotonicMs = 1_900;
    internal.recordCommissioningTimingCompletion(completion(1_950, {
      startedAtMs: 1_800,
      valid: false,
      completionCause: "insufficient-frames",
    }));
    expect(internal.commissioningFaults.size).toBe(0);
    // This scheduler revisit crossed the warm-up boundary. It becomes the
    // qualification anchor and cannot fail the new epoch.
    internal.recordCommissioningTimingCompletion(completion(2_000, {
      startedAtMs: 1_800,
      previousValidCompletionMs: 1_000,
      revisitMs: 1_000,
      missedObjective: true,
      missByMs: 500,
      missCause: "revisit-objective-missed",
    }));
    expect(internal.commissioningFaults.size).toBe(0);
    expect(internal.commissioningValidRevisitsByTarget.size).toBe(0);

    internal.recordCommissioningTimingCompletion(completion(2_400, {
      previousValidCompletionMs: 2_000,
      revisitMs: 400,
    }));
    expect(internal.commissioningValidRevisitsByTarget.get("gnss-l1-e1-b1c-sbas")).toBe(1);
    expect(internal.commissioningOnTimeRevisitsByTarget.get("gnss-l1-e1-b1c-sbas")).toBe(1);
    expect(internal.commissioningFaults.size).toBe(0);

    internal.recordCommissioningTimingCompletion(completion(3_100, {
      previousValidCompletionMs: 2_400,
      revisitMs: 700,
      missedObjective: true,
      missByMs: 200,
      missCause: "revisit-objective-missed",
    }));
    expect(internal.commissioningValidRevisitsByTarget.get("gnss-l1-e1-b1c-sbas")).toBe(2);
    expect(internal.commissioningOnTimeRevisitsByTarget.get("gnss-l1-e1-b1c-sbas")).toBe(1);
    expect(internal.commissioningFaults.size).toBe(0);
    await monitor.stop();
  });

  it("keeps qualification scan readiness false when the 24-hour clock has no valid coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const monitor = new MonitorService(await temporaryConfig("qualification-no-valid-coverage"));
    await monitor.start();
    const internal = monitor as unknown as {
      commissioningStartedAtMonotonicMs: number;
      commissioningStartedAtWallMs: number;
      commissioningLastValidCompletionByTarget: Map<string, number>;
      commissioningValidRevisitsByTarget: Map<string, number>;
      commissioningOnTimeRevisitsByTarget: Map<string, number>;
    };
    internal.commissioningStartedAtMonotonicMs = performance.now() - DEVELOPMENT_QUALIFICATION_WINDOW_MS;
    internal.commissioningStartedAtWallMs = Date.now() - DEVELOPMENT_QUALIFICATION_WINDOW_MS;
    expect(monitor.getCommissioningHealth()).toMatchObject({
      scanObjectiveReady: false,
      resourceSoakClean: true,
      faults: [],
    });
    internal.commissioningLastValidCompletionByTarget.set("gnss-l1-e1-b1c-sbas", performance.now());
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(false);
    internal.commissioningValidRevisitsByTarget.set("gnss-l1-e1-b1c-sbas", 1_000);
    internal.commissioningOnTimeRevisitsByTarget.set("gnss-l1-e1-b1c-sbas", 999);
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(true);
    internal.commissioningOnTimeRevisitsByTarget.set("gnss-l1-e1-b1c-sbas", 998);
    expect(monitor.getCommissioningHealth().scanObjectiveReady).toBe(false);
    await monitor.stop();
  });

  it("starts timing and evidence-drop qualification cleanly for each configuration epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("qualification-epoch");
    const monitor = new MonitorService(base);
    await monitor.start();
    const firstCommissioningEpochId = monitor.getCommissioningHealth().epochId;
    await vi.advanceTimersByTimeAsync(1_600);
    expect(monitor.getTargetTimingHealth().some((target) => target.completedVisits + target.unknownVisits > 0)).toBe(true);

    const internal = monitor as unknown as {
      evidenceFramesDropped: number;
      commissioningFaults: Set<string>;
    };
    internal.evidenceFramesDropped = 7;
    internal.commissioningFaults.add("evidence-frame-drop");
    expect(monitor.getCommissioningHealth().resourceSoakClean).toBe(false);

    const settings = structuredClone(base.operationalSettings);
    settings.revision += 1;
    settings.siteName = "New qualification epoch";
    await monitor.reconfigure(withOperationalSettings(base, settings));

    expect(monitor.getProcessingHealth().evidenceFramesDropped).toBe(7);
    expect(monitor.getCommissioningHealth()).toMatchObject({ resourceSoakClean: true, faults: [] });
    expect(monitor.getCommissioningHealth().epochId).not.toBe(firstCommissioningEpochId);
    expect(monitor.getTargetTimingHealth().every((target) => (
      target.completedVisits === 0
      && target.unknownVisits === 0
      && target.revisitMs.samples === 0
      && target.unobservedGapMs.samples === 0
    ))).toBe(true);

    internal.evidenceFramesDropped += 1;
    expect(monitor.getCommissioningHealth().resourceSoakClean).toBe(false);
    await monitor.stop();
  });

  it("keeps baseline review independent from historical commissioning faults", async () => {
    const monitor = new MonitorService(await temporaryConfig("baseline-approval-blocked"));
    await monitor.start();
    const baseline: BaselineDescriptor = {
      dataDomain: "field",
      targetId: "gnss-l1-e1-b1c-sbas",
      lifecycle: "reviewable",
      fingerprintId: "a".repeat(64),
      learningGenerationId: "1",
      observationCount: 100,
      validCoverageRatio: 1,
      representativeHours: 24,
      learningStartedAt: "2026-08-20T12:00:00.000Z",
    };
    vi.spyOn(monitor, "getBaselineStates").mockReturnValue([baseline]);
    const internal = monitor as unknown as {
      config: { dataDomain: "field" | "test" };
      activeBaselineFingerprints: Map<string, Record<string, unknown>>;
      activeBaselineFingerprintIdByTarget: Map<string, string>;
      evidenceHealthy: boolean;
      targetStates: Map<string, ChannelMonitorState>;
      receiverStates: Array<{
        deviceReady: boolean;
        streamReady: boolean;
        connection: "live";
        streamState: "running";
        deviceName: string;
        lastFrameAt: string;
      }>;
    };
    internal.config.dataDomain = "field";
    internal.receiverStates = [{
      deviceReady: true,
      streamReady: true,
      connection: "live",
      streamState: "running",
      deviceName: "RSPdx",
      lastFrameAt: new Date().toISOString(),
    }];
    internal.activeBaselineFingerprints.set(`${baseline.targetId}:${baseline.fingerprintId}`, {});
    internal.activeBaselineFingerprintIdByTarget.set(baseline.targetId, baseline.fingerprintId);
    const commissioning = vi.spyOn(monitor, "getCommissioningHealth").mockReturnValue({
      epochId: "commissioning-test",
      state: "invalidated",
      ready: false,
      receiverReady: true,
      sampleRateReady: true,
      simulation: false,
      dataDomain: "field",
      soakRequiredMs: DEVELOPMENT_QUALIFICATION_WINDOW_MS,
      soakElapsedMs: 60_000,
      soakStartedAt: "2026-08-20T12:00:00.000Z",
      scanObjectiveReady: false,
      resourceSoakClean: false,
      faults: ["unknown-visit:insufficient-frames"],
    });

    expect(monitor.getBaselineApprovalEligibility()[0]).toMatchObject({
      eligible: true,
      state: "eligible",
      label: "Ready for review",
    });
    expect(commissioning()).toMatchObject({ ready: false, state: "invalidated" });
    expect(monitor.getSnapshot().operatorSummary.monitoring).toMatchObject({
      state: "checking",
      reasonCode: "baseline-review-required",
      actionCode: "open-signal-learning",
    });

    baseline.lifecycle = "protected";
    internal.targetStates.set(baseline.targetId, {
      targetId: baseline.targetId,
      lifecycle: "clear",
      candidateCount: 0,
      clearCount: 0,
      requiredCount: 3,
      lastObservedAt: new Date().toISOString(),
      baselineLifecycle: "protected",
      observationDisposition: "clean",
    });
    const protectedSnapshot = monitor.getSnapshot();
    expect(protectedSnapshot.operatorSummary.monitoring).toMatchObject({ state: "normal", reasonCode: "monitoring-normal" });
    expect(protectedSnapshot.operatorSummary.productionQualification).toMatchObject({ state: "pending", ready: false });

    baseline.lifecycle = "reviewable";
    internal.evidenceHealthy = false;
    const approval = monitor.getBaselineApprovalEligibility()[0];
    expect(approval).toMatchObject({
      eligible: false,
      state: "blocked",
      label: "Recording issue",
      detail: "Current evidence recording is not healthy.",
    });
    await expect(monitor.approveBaseline({
      targetId: baseline.targetId,
      expectedFingerprintId: baseline.fingerprintId,
      expectedGeneration: 1,
      approvedBy: "test",
    })).rejects.toMatchObject({ name: "BaselineApprovalUnavailableError", code: "BASELINE_APPROVAL_BLOCKED", approval });
    expect(BaselineApprovalUnavailableError).toBeTypeOf("function");
    await monitor.stop();
  });

  it("does not apply the fast-profile 24-hour optional gate to a legacy priority profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("legacy-priority");
    const settings = structuredClone(base.operationalSettings);
    settings.scan.profile = "gnss-priority";
    const monitor = new MonitorService(withOperationalSettings(base, settings));
    await monitor.start();
    expect(monitor.getSchedulerHealth()).toMatchObject({
      profile: "gnss-priority",
      optionalQualificationReady: true,
    });
    await monitor.stop();
  });

  it("publishes a completed bounded radio survey when radio monitoring is explicitly enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("sweep");
    const settings = structuredClone(base.operationalSettings);
    settings.scan.profile = "balanced";
    settings.monitoring.gnss.enabled = false;
    settings.monitoring.gnss.enabledSignalIds = [];
    settings.monitoring.gnss.enabledSystemIds = [];
    for (const group of Object.values(settings.monitoring.gnss.constellations)) {
      group.enabled = false;
      for (const signal of Object.values(group.signals)) signal.enabled = false;
    }
    settings.monitoring.startrack.enabled = true;
    settings.monitoring.startrack.channels = { mode: "all", frequenciesHz: [] };
    settings.monitoring["4dx"].enabled = false;
    const monitor = new MonitorService(withOperationalSettings(base, settings));
    const feedFrames: Array<{ feedId?: string; bins: Uint8Array }> = [];
    const completedStatuses: string[] = [];
    monitor.on("message", (message) => {
      if (message.type === "frame" && message.payload.feedId) {
        feedFrames.push({ feedId: message.payload.feedId, bins: message.payload.frame.bins });
        completedStatuses.push(monitor.getSnapshot().sweepCycles.find((cycle) => cycle.feedId === message.payload.feedId)?.status ?? "missing");
      }
    });
    await monitor.start();

    await vi.advanceTimersByTimeAsync(8_000);
    const sweep = monitor.getSnapshot().sweepCycles.find((cycle) => cycle.feedId === "survey-startrack");
    expect(sweep?.stitchedFrame).toMatchObject({ startHz: 410_000_000, endHz: 470_000_000 });
    expect(sweep?.stitchedFrame?.bins).toHaveLength(720);
    expect(sweep?.waterfall).toHaveLength(1);
    expect(feedFrames).toContainEqual({ feedId: "survey-startrack", bins: expect.any(Uint8Array) });
    expect(completedStatuses).toContain("complete");
    expect(monitor.getSweepFrames(["survey-startrack"])).toHaveLength(1);
    expect(monitor.getSweepFrames(["survey-startrack"])[0].payload.frame.bins).toHaveLength(720);
    expect(monitor.getSweepFrames(["survey-startrack"])[0].payload.frame).toMatchObject({ binning: "peak-preserving" });
    expect(monitor.getSweepFrames(["survey-startrack"])[0].payload.frame.analysisStartBin).toBeGreaterThan(0);
    expect(monitor.getSweepFrames(["survey-startrack"])[0].payload.frame.analysisEndBin).toBeLessThan(720);
    expect(monitor.getSweepFrames(["survey-4dx"])).toHaveLength(0);
    await monitor.stop();
  });

  it("publishes 4DX as one logical completed-sweep frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("4dx-sweep");
    const settings = structuredClone(base.operationalSettings);
    settings.scan.profile = "balanced";
    settings.monitoring.gnss.enabled = false;
    settings.monitoring.gnss.enabledSignalIds = [];
    settings.monitoring.gnss.enabledSystemIds = [];
    for (const group of Object.values(settings.monitoring.gnss.constellations)) {
      group.enabled = false;
      for (const signal of Object.values(group.signals)) signal.enabled = false;
    }
    settings.monitoring.startrack.enabled = false;
    settings.monitoring["4dx"].enabled = true;
    settings.monitoring["4dx"].channels = { mode: "all", frequenciesHz: [], startChannel: 1, endChannel: 91 };
    const monitor = new MonitorService(withOperationalSettings(base, settings));
    const feedIds: string[] = [];
    monitor.on("message", (message) => {
      if (message.type === "frame" && message.payload.feedId) feedIds.push(message.payload.feedId);
    });
    await monitor.start();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(feedIds).toContain("survey-4dx");
    expect(monitor.getSweepFrames(["survey-4dx"])[0].payload.frame).toMatchObject({
      bandId: "survey-4dx",
      startHz: 902_400_000,
      endHz: 927_600_000,
      bins: expect.any(Uint8Array),
    });
    expect(monitor.getSweepFrames(["survey-4dx"])[0].payload.frame.bins).toHaveLength(720);
    await monitor.stop();
  });

  it("advances detection once per three-frame visit and records incomplete visits as unknown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("visits"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);

    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    expect(monitor.getBaselineStates()).toHaveLength(0);
    internal.handleSpectrum(0, quiet, "simulation");
    // The persistent generation owns cold-start rows. The first valid visit is
    // retained there immediately instead of living only in detector memory.
    expect(monitor.getBaselineStates()[0]).toMatchObject({ lifecycle: "learning", observationCount: 1 });
    expect(monitor.getSnapshot().operatorStatus).toBe("Checking");
    const activeTarget = monitor.getSnapshot().monitorTargets[0];
    const learning = monitor.getBaselineStates()[0];
    const baselineStates = vi.spyOn(monitor, "getBaselineStates");
    const status = (monitor as unknown as {
      operatorStatus(monitoringReady: boolean, targets: typeof activeTarget[]): string;
    }).operatorStatus.bind(monitor);
    baselineStates.mockReturnValue([{ ...learning, lifecycle: "reviewable" }]);
    expect(status(true, [activeTarget])).toBe("Checking");
    baselineStates.mockReturnValue([{ ...learning, lifecycle: "protected", protectedAt: new Date().toISOString() }]);
    expect(status(true, [activeTarget])).toBe("Normal");
    baselineStates.mockReturnValue([
      { ...learning, lifecycle: "protected", protectedAt: new Date().toISOString(), learningGenerationId: "1" },
      { ...learning, lifecycle: "learning", learningGenerationId: "2" },
    ]);
    expect(status(true, [activeTarget])).toBe("Checking");
    baselineStates.mockRestore();
    expect(monitor.getSchedulerHealth()).toMatchObject({ completedVisits: 1, unknownVisits: 0 });
    expect(monitor.getTargetTimingHealth()[0]).toMatchObject({
      completedVisits: 1,
      unknownVisits: 0,
      revisitMs: { samples: 0 },
      revisitHistogram: { samples: 0 },
    });

    await vi.advanceTimersByTimeAsync(1);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(monitor.getSchedulerHealth().unknownVisits).toBe(1);
    expect(monitor.getBaselineStates()[0]).toMatchObject({
      fingerprintId: learning.fingerprintId,
      observationCount: 1,
      validCoverageRatio: 0.5,
    });
    expect(monitor.getTargetTimingHealth()[0]).toMatchObject({
      completedVisits: 1,
      unknownVisits: 1,
      unobservedGapMs: { samples: 1 },
      unobservedGapHistogram: { samples: 1 },
      missesByCause: {},
      unknownsByCause: { "insufficient-frames": 1 },
    });
    expect(monitor.getSnapshot().targetStates[0]).toMatchObject({ observationDisposition: "unknown", unknownReason: "insufficient-frames" });
    expect(monitor.getSnapshot()).not.toHaveProperty("activeIncidentHold");
    await monitor.stop();
  });

  it("accepts SDRconnect frames only for the immutable active configuration, tune, and visit epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("rf-epoch-gate"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      assignments: Array<{ active?: { epoch: Readonly<ExpectedSdrconnectFrameEpoch>; target: { id: string } } }>;
      rejectedRfEpochFrames: number;
      acceptedAttributionInvariantViolations: number;
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "sdrconnect", transport: SdrconnectSpectrumPayload): void;
    };
    internal.stopSimulation();
    const epoch = internal.assignments[0].active?.epoch;
    expect(epoch).toBeDefined();
    expect(Object.isFrozen(epoch)).toBe(true);
    const confirmedMonotonicMs = 1;
    const valid: SdrconnectSpectrumPayload = {
      bins: new Uint8Array(640).fill(30),
      ...epoch!,
      confirmedCenterHz: epoch!.requestedCenterHz,
      confirmedSampleRateHz: epoch!.sampleRateHz,
      tuneConfirmedAt: "2026-08-20T11:59:59.500Z",
      tuneConfirmedMonotonicMs: confirmedMonotonicMs,
      receivedMonotonicMs: 251,
      discardedFrames: 2,
    };
    const staleFrames = [
      { ...valid, configurationEpoch: valid.configurationEpoch - 1 },
      { ...valid, tuneEpoch: valid.tuneEpoch - 1 },
      { ...valid, visitEpoch: valid.visitEpoch - 1 },
      { ...valid, visitId: `old-${valid.visitId}` },
      { ...valid, targetId: `old-${valid.targetId}` },
      { ...valid, confirmedCenterHz: valid.confirmedCenterHz + 1 },
      { ...valid, confirmedSampleRateHz: 9_000_000 },
      { ...valid, receivedMonotonicMs: valid.tuneConfirmedMonotonicMs - 1 },
    ];

    for (const stale of staleFrames) internal.handleSpectrum(0, stale.bins, "sdrconnect", stale);
    expect(internal.rejectedRfEpochFrames).toBe(staleFrames.length);
    expect(monitor.getSnapshot().currentFrame).toBeUndefined();
    expect(monitor.getProcessingHealth().invalidSpectrumFramesDropped).toBeGreaterThanOrEqual(staleFrames.length);
    expect(internal.acceptedAttributionInvariantViolations).toBe(0);

    internal.handleSpectrum(0, valid.bins, "sdrconnect", valid);
    expect(monitor.getSnapshot().currentFrame).toMatchObject({
      targetId: epoch!.targetId,
      configurationEpoch: epoch!.configurationEpoch,
      tuneEpoch: epoch!.tuneEpoch,
      visitEpoch: epoch!.visitEpoch,
      visitId: epoch!.visitId,
      requestedCenterHz: epoch!.requestedCenterHz,
      confirmedCenterHz: epoch!.requestedCenterHz,
      confirmedSampleRateHz: epoch!.sampleRateHz,
    });
    const acceptedTarget = internal.assignments[0].active!.target;
    const acceptedTargetId = acceptedTarget.id;
    acceptedTarget.id = `post-gate-${acceptedTargetId}`;
    internal.handleSpectrum(0, valid.bins, "sdrconnect", valid);
    expect(internal.acceptedAttributionInvariantViolations).toBe(1);
    expect(monitor.getProcessingHealth().acceptedAttributionInvariantViolations).toBe(1);
    acceptedTarget.id = acceptedTargetId;
    await monitor.stop();
  });

  it("accepts non-alerting candidates into the learning baseline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("baseline-quarantine"));
    config.evidenceFrameIntervalMs = 1;
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    const elevated = new Uint8Array(640).fill(96);
    const completeVisit = async (bins: Uint8Array) => {
      internal.handleSpectrum(0, bins, "simulation");
      internal.handleSpectrum(0, bins, "simulation");
      internal.handleSpectrum(0, bins, "simulation");
      await vi.advanceTimersByTimeAsync(1);
    };

    for (let index = 0; index < 8; index += 1) await completeVisit(quiet);
    expect(monitor.getBaselineStates()[0]).toMatchObject({ lifecycle: "learning", observationCount: 8 });

    // Unprotected learning treats a pending, non-alerting candidate as local
    // site conditions, so these visits train instead of being quarantined.
    for (let index = 0; index < 12; index += 1) await completeVisit(elevated);
    expect(monitor.getBaselineStates()[0]).toMatchObject({
      lifecycle: "learning",
      observationCount: 20,
      learningExclusions: { rejectedVisits: 0, disqualifiedHours: 0 },
    });

    await completeVisit(quiet);
    expect(monitor.getBaselineStates()[0].observationCount).toBeGreaterThan(20);
    await monitor.stop();
  });

  it("does not freeze a clean target because another target has an anomaly candidate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const base = await temporaryConfig("target-scoped-learning-freeze");
    const multiBand = applyMonitoringMission(base.operationalSettings, base.bandCatalog, "gnss-survey");
    const monitor = new MonitorService(withOperationalSettings(base, multiBand));
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      assignments: Array<{ active?: { target: { id: string } }; targets: Array<{ id: string }> }>;
      prehistoryCandidateTargets: Set<string>;
      detector: { analyzeObservation: (...args: unknown[]) => unknown };
    };
    internal.stopSimulation();
    const activeTargetId = internal.assignments[0].active?.target.id;
    const unrelatedTargetId = internal.assignments[0].targets.find((target) => target.id !== activeTargetId)?.id;
    expect(activeTargetId).toBeDefined();
    expect(unrelatedTargetId).toBeDefined();
    internal.prehistoryCandidateTargets.add(unrelatedTargetId!);
    const analyze = vi.spyOn(internal.detector, "analyzeObservation");
    const quiet = new Uint8Array(640).fill(30);

    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");

    const unrelatedCandidateOptions = analyze.mock.calls.at(-1)?.[2];
    await monitor.stop();
    expect(analyze).toHaveBeenCalled();
    expect(unrelatedCandidateOptions).toMatchObject({ freezeTraining: false });
  });

  it("keeps a receiver-wide evidence outage frozen for learning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const monitor = new MonitorService(enableSingleRadioTarget(await temporaryConfig("receiver-wide-learning-freeze")));
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      evidenceHealthy: boolean;
      detector: { analyzeObservation: (...args: unknown[]) => unknown };
    };
    internal.stopSimulation();
    internal.evidenceHealthy = false;
    const analyze = vi.spyOn(internal.detector, "analyzeObservation");
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    const options = analyze.mock.calls.at(-1)?.[2];
    await monitor.stop();

    expect(analyze).toHaveBeenCalled();
    expect(options).toMatchObject({ freezeTraining: true });
  });

  it("atomically restarts persistent and in-memory learning on only the new generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("atomic-learning-restart"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      detector: { getBaselineStates(): Array<{ targetId: string; learningGenerationId: string; observationCount: number }> };
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    const before = monitor.getBaselineStates()[0];
    expect(before).toMatchObject({ dataDomain: "test", learningGenerationId: "1" });

    const restarted = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });

    expect(restarted).toMatchObject({ committed: true, state: "complete", auditDurable: true });
    expect(restarted.baseline).toMatchObject({ dataDomain: "test", lifecycle: "learning", learningGenerationId: "2", observationCount: 0 });
    expect(internal.detector.getBaselineStates()).toEqual([
      expect.objectContaining({ targetId: before.targetId, learningGenerationId: "2", observationCount: 0 }),
    ]);
    expect(monitor.getSnapshot().targetStates.find((state) => state.targetId === before.targetId)).toMatchObject({
      lifecycle: "clear",
      candidateCount: 0,
      observationDisposition: "unknown",
    });
    expect(monitor.getBaselineStates().filter((baseline) => baseline.targetId === before.targetId).at(-1)).toMatchObject({ learningGenerationId: "2" });
    await monitor.stop();
  });

  it("blocks a learning restart during an active alert unless the operator confirms ending it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("restart-during-alert"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      targetStates: Map<string, Record<string, unknown>>;
      activeEventsByTarget: Map<string, Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
      clearTargetState(targetId: string): Record<string, unknown>;
      refreshActiveEvent(): void;
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    const before = monitor.getBaselineStates()[0];

    // Put the target into the same state a persistent false alarm leaves it in.
    const event: Record<string, unknown> = {
      id: "event-under-restart", dataDomain: "test", sessionId: "s", kind: "gnss-energy-anomaly", status: "interference-likely",
      severity: "medium", evidenceStrength: "Medium", evidenceBasis: "test", baselineFingerprintId: before.fingerprintId, ruleSetId: "r",
      observationId: "o", service: "gnss", bandId: "b", targetId: before.targetId, bandLabel: "b", affectedRangeHz: [1, 2],
      observed: "x", recommendedAction: "y", startedAt: "2026-08-20T11:59:00.000Z", lastSeenAt: "2026-08-20T11:59:30.000Z",
      lifecycle: "active", notes: [], metrics: {},
    };
    internal.events = [event, ...internal.events];
    internal.activeEventsByTarget.set(before.targetId, event);
    internal.targetStates.set(before.targetId, { ...internal.clearTargetState(before.targetId), lifecycle: "active", candidateCount: 3, eventId: event.id });
    internal.refreshActiveEvent();

    const request = { targetId: before.targetId, expectedFingerprintId: before.fingerprintId, expectedGeneration: 1, restartedBy: "settings-admin" };
    await expect(monitor.restartBaseline(request)).rejects.toThrow("Wait for the active or recovering observation to clear");
    await expect(monitor.restartBaseline({ ...request, endActiveObservation: false })).rejects.toThrow("Wait for the active or recovering");
    expect(event.lifecycle).toBe("active");

    const restarted = await monitor.restartBaseline({ ...request, endActiveObservation: true });
    expect(restarted).toMatchObject({ committed: true, state: "complete", auditDurable: true });
    expect(restarted.baseline).toMatchObject({ lifecycle: "learning", learningGenerationId: "2", observationCount: 0 });
    expect(event).toMatchObject({ lifecycle: "ended-unknown", endReason: expect.stringContaining("restarted by the operator") });
    expect(typeof event.endedAt).toBe("string");
    expect(internal.activeEventsByTarget.has(before.targetId)).toBe(false);
    expect(monitor.getSnapshot().targetStates.find((state) => state.targetId === before.targetId)).toMatchObject({ lifecycle: "clear", candidateCount: 0 });
    expect(monitor.getSnapshot().activeEvent).toBeUndefined();

    const audit = await readFile(path.join(config.dataRoots.baseRoot, "domain-maintenance-audit.jsonl"), "utf8");
    const entries = audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.type === "baseline-learning-restarted")).toMatchObject({ endedEventIds: ["event-under-restart"] });
    await monitor.stop();
  });

  it("saves a time-stamped incident image when an incident ends, only while the option is on, and prunes old ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("incident-figure"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      figureScheduler: { eventEnded(event: Record<string, unknown>): void };
      figureQueue: Promise<void>;
      evidence: { currentSession?: { id: string }; flush(): Promise<void> };
      config: { retentionPolicy: Record<string, unknown> };
      runStorageMaintenance(): Promise<unknown>;
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    for (let index = 0; index < 4; index += 1) {
      vi.setSystemTime(new Date(Date.parse("2026-08-20T12:00:00.000Z") + index * 2_500));
      internal.handleSpectrum(0, quiet, "simulation");
    }
    await internal.evidence.flush();
    const sessionId = internal.evidence.currentSession!.id;
    const target = monitor.getBaselineStates()[0];
    const incident = {
      id: "incident-image-1", dataDomain: "test", sessionId, sessionIds: [sessionId], kind: "gnss-energy-anomaly", status: "interference-likely",
      severity: "medium", evidenceStrength: "Medium", evidenceBasis: "test", baselineFingerprintId: target.fingerprintId, ruleSetId: "r",
      observationId: "o", service: "gnss", bandId: "b", targetId: target.targetId, bandLabel: "Test window", affectedRangeHz: [1, 2],
      observed: "Narrowband energy stayed above its usual level.", recommendedAction: "Keep recording.",
      startedAt: "2026-08-20T11:59:00.000Z", lastSeenAt: "2026-08-20T12:00:10.000Z", clearedAt: "2026-08-20T12:00:10.000Z",
      lifecycle: "cleared", notes: [], metrics: {},
    };
    const imageDirectory = path.join(config.dataRoots.test.evidenceRoot, "incident-figures", incident.id);
    const savedNames = async () => (await readdir(imageDirectory).catch(() => [])).sort();

    internal.config.retentionPolicy.incidentFiguresEnabled = false;
    internal.figureScheduler.eventEnded(incident);
    await internal.figureQueue;
    expect(await savedNames()).toEqual([]);

    internal.config.retentionPolicy.incidentFiguresEnabled = true;
    internal.figureScheduler.eventEnded(incident);
    await internal.figureQueue;
    const names = await savedNames();
    expect(names).toHaveLength(5);
    expect(names.every((name) => /^20260820T\d{6}Z-end(-analysis|-report)?\.(svg|png|html|json)$/.test(name))).toBe(true);
    expect(await readFile(path.join(imageDirectory, names.find((name) => name.endsWith("-end.svg"))!), "utf8")).toContain("Figure generated (UTC) 2026-08-20");
    expect((await monitor.getIncidentFigure(incident.id, "svg"))?.reason).toBe("end");

    // The user's retention choice deletes it: 1 day kept, 2 days later.
    internal.config.retentionPolicy.incidentFigureRetentionMs = 86_400_000;
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    await internal.runStorageMaintenance();
    expect(await savedNames()).toEqual([]);
    await monitor.stop();
  });

  it("ignores frames and does not report a storage fault once a clean shutdown has begun", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("clean-shutdown"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      markStorageError(error?: unknown): void;
      detector: { analyzeObservation(...arguments_: unknown[]): unknown };
      evidence: { closeActive(): Promise<unknown> };
      evidenceHealthy: boolean;
      storageReprobeTimer?: unknown;
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    for (let index = 0; index < 3; index += 1) internal.handleSpectrum(0, quiet, "simulation");
    const analyze = vi.spyOn(internal.detector, "analyzeObservation");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // While the session is being closed, a late receiver frame and a late write failure both arrive.
    const closeActive = internal.evidence.closeActive.bind(internal.evidence);
    internal.evidence.closeActive = async () => {
      const result = await closeActive();
      vi.setSystemTime(new Date("2026-08-20T12:00:10.000Z"));
      internal.handleSpectrum(0, quiet, "simulation");
      internal.markStorageError(new Error("Evidence session is not initialized"));
      return result;
    };
    await monitor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(analyze).not.toHaveBeenCalled();
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("Evidence write failed"))).toEqual([]);
    expect(internal.evidenceHealthy).toBe(true);
    expect(internal.storageReprobeTimer).toBeUndefined();
    errors.mockRestore();
  });

  it("restarts signal learning for the Fugro L-band capture target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableFugroTarget(await temporaryConfig("fugro-learning-restart"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      detector: { getBaselineStates(): Array<{ targetId: string; learningGenerationId: string; observationCount: number }> };
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    const before = monitor.getBaselineStates()[0];
    expect(before).toMatchObject({ targetId: "fugro-corrections-lband", dataDomain: "test", learningGenerationId: "1" });

    const restarted = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });

    expect(restarted).toMatchObject({ committed: true, state: "complete", auditDurable: true });
    expect(restarted.baseline).toMatchObject({ dataDomain: "test", lifecycle: "learning", learningGenerationId: "2", observationCount: 0 });
    expect(internal.detector.getBaselineStates()).toEqual([
      expect.objectContaining({ targetId: "fugro-corrections-lband", learningGenerationId: "2", observationCount: 0 }),
    ]);
    await monitor.stop();
  });

  it("returns committed recovery at the detector-reset boundary and startup activates only the new generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("restart-detector-boundary"));
    let armed = false;
    const monitor = new MonitorService(config, {
      injectAtomicityFault(point) {
        if (armed && point === "baseline-before-detector-reset") {
          armed = false;
          throw new Error("injected detector reset failure");
        }
      },
    });
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      baselineStore: { flush(): Promise<void> };
      detector: { getBaselineStates(): Array<{ learningGenerationId: string }> };
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    await internal.baselineStore.flush();
    const before = monitor.getBaselineStates()[0];
    const detectorGenerationBefore = internal.detector.getBaselineStates()[0].learningGenerationId;
    armed = true;

    const result = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });

    expect(result).toMatchObject({ committed: true, state: "recovery-required", auditDurable: false });
    expect(result.baseline.learningGenerationId).toBe("2");
    expect(internal.detector.getBaselineStates()).toEqual([
      expect.objectContaining({ learningGenerationId: detectorGenerationBefore }),
    ]);
    await monitor.stop();

    const restarted = new MonitorService(config);
    await restarted.start();
    expect(restarted.getBaselineStates().at(-1)).toMatchObject({ learningGenerationId: "2", observationCount: 0 });
    const restartedInternal = restarted as unknown as {
      detector: { getBaselineStates(): Array<{ learningGenerationId: string; observationCount: number }> };
    };
    expect(restartedInternal.detector.getBaselineStates()).toEqual([
      expect.objectContaining({ learningGenerationId: "2", observationCount: 0 }),
    ]);
    const audit = await readFile(path.join(config.dataRoots.baseRoot, "domain-maintenance-audit.jsonl"), "utf8");
    expect(audit).toContain('"recovered":true');
    await restarted.stop();
  });

  it("does not report a generic failure when baseline rename succeeds before directory fsync fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("restart-post-rename"));
    let armed = false;
    const monitor = new MonitorService(config, {
      injectAtomicityFault(point) {
        if (armed && point === "baseline-after-file-rename") {
          armed = false;
          throw new Error("injected directory fsync failure");
        }
      },
    });
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      baselineStore: { flush(): Promise<void> };
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    await internal.baselineStore.flush();
    const before = monitor.getBaselineStates()[0];
    armed = true;

    const uncertain = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });
    expect(uncertain).toMatchObject({ committed: true, state: "recovery-required", baseline: { learningGenerationId: "2" } });

    const recovered = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });
    expect(recovered).toMatchObject({ committed: true, state: "complete", auditDurable: true, baseline: { learningGenerationId: "2" } });
    await monitor.stop();
  });

  it("keeps the original learning generation after a pre-commit audit failure and allows a clean retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("restart-audit-boundary"));
    let armed = false;
    const monitor = new MonitorService(config, {
      injectAtomicityFault(point) {
        if (armed && point === "baseline-before-prepared-audit") {
          armed = false;
          throw new Error("injected durable audit failure");
        }
      },
    });
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
      baselineStore: { flush(): Promise<void> };
    };
    internal.stopSimulation();
    const quiet = new Uint8Array(640).fill(30);
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    internal.handleSpectrum(0, quiet, "simulation");
    await internal.baselineStore.flush();
    const before = monitor.getBaselineStates()[0];
    armed = true;

    await expect(monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    })).rejects.toThrow("injected durable audit failure");
    expect(monitor.getBaselineStates().at(-1)).toMatchObject({ learningGenerationId: "1" });

    const retried = await monitor.restartBaseline({
      targetId: before.targetId,
      expectedFingerprintId: before.fingerprintId,
      expectedGeneration: 1,
      restartedBy: "settings-admin",
    });
    expect(retried).toMatchObject({ state: "complete", auditDurable: true, baseline: { learningGenerationId: "2" } });
    await monitor.stop();
  });

  it("clears active test data without changing a byte in the field tree", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("clear-test-domain");
    await mkdir(config.dataRoots.field.root, { recursive: true });
    await writeFile(path.join(config.dataRoots.field.root, "field-evidence.bin"), "field-must-remain");
    const fieldBefore = await treeHash(config.dataRoots.field.root);
    const monitor = new MonitorService(config);
    await monitor.start();
    await vi.advanceTimersByTimeAsync(1_500);
    const oldSessionId = monitor.getSnapshot().sessions[0].id;

    const result = await monitor.clearTestData("settings-admin");

    expect(result).toMatchObject({ domain: "test", previousDataPresent: true });
    expect(await treeHash(config.dataRoots.field.root)).toBe(fieldBefore);
    expect(monitor.getSnapshot()).toMatchObject({ dataDomain: "test", events: [], evidenceHealthy: true });
    expect(monitor.getSnapshot().sessions.some((session) => session.id === oldSessionId)).toBe(false);
    expect(monitor.getBaselineStates()).toEqual([]);
    expect(await readFile(path.join(config.dataRoots.baseRoot, "domain-maintenance-audit.jsonl"), "utf8")).toContain('"test-data-cleared"');
    await monitor.stop();
  });

  it("returns committed recovery when the fresh test runtime cannot reopen, then starts cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("clear-runtime-reopen");
    await ensureDomainRoot(config.dataRoots.field.root, "field");
    await writeFile(path.join(config.dataRoots.field.root, "field.bin"), "field-original");
    const fieldBefore = await treeHash(config.dataRoots.field.root);
    let armed = true;
    const monitor = new MonitorService(config, {
      injectAtomicityFault(point) {
        if (armed && point === "clear-before-runtime-reopen") {
          armed = false;
          throw new Error("injected runtime reopen failure");
        }
      },
    });
    await monitor.start();

    const result = await monitor.clearTestData("settings-admin");

    expect(result).toMatchObject({ committed: true, state: "recovery-required", runtimeState: "recovery-required", auditDurable: true });
    expect(await treeHash(config.dataRoots.field.root)).toBe(fieldBefore);
    await monitor.stop();
    const restarted = new MonitorService(config);
    await restarted.start();
    expect(restarted.getBaselineStates()).toEqual([]);
    expect(restarted.getSnapshot()).toMatchObject({ dataDomain: "test", evidenceHealthy: true });
    expect(await treeHash(config.dataRoots.field.root)).toBe(fieldBefore);
    await restarted.stop();
  });

  it("repairs an after-rename clear crash before startup opens the test stores", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("clear-startup-repair");
    await ensureDomainRoot(config.dataRoots.test.root, "test");
    await writeFile(path.join(config.dataRoots.test.root, "old-test.bin"), "old-test-data");
    const interrupted = await clearTestDomain(config.dataRoots, {
      operationId: "monitor-startup-repair-0001",
      injectFault(point) {
        if (point === "after-commit-rename") throw new Error("injected crash");
      },
    });
    expect(interrupted.state).toBe("recovery-required");

    const monitor = new MonitorService(config);
    await monitor.start();

    await expect(readFile(path.join(config.dataRoots.test.root, "old-test.bin"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(monitor.getSnapshot()).toMatchObject({ dataDomain: "test", evidenceHealthy: true });
    await monitor.stop();
  });

  it("requires receiver identity plus documented SDRconnect display and LNA fields for a complete RF fingerprint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const monitor = new MonitorService(await temporaryConfig("fingerprint-health"));
    await monitor.start();
    const internal = monitor as unknown as {
      stopSimulation(): void;
      handleProperty(receiverId: number, message: { event_type: string; property: string; value: string }): void;
      fingerprintHealthComplete(receiverId: number, source: "sdrconnect"): boolean;
    };
    internal.stopSimulation();
    const property = (name: string, value: string) => internal.handleProperty(0, {
      event_type: "get_property_response",
      property: name,
      value,
    });

    property("active_device", "RSPdx Pro");
    property("api_version", "1.0.3");
    property("active_antenna", "Antenna A");
    expect(monitor.getSnapshot().receivers[0].activeAntenna).toBe("Antenna A");
    property("lna_state", "0");
    property("spectrum_base", "-145");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(false);

    property("spectrum_ref_level", "-20");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(false);

    property("device_serial", "RSPDX-TEST-0001");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(false);

    property("active_device", "RSPdx");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(true);

    property("active_device", "RSPdx (2237073D48)");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(true);

    property("spectrum_ref_level", "not-a-number");
    expect(internal.fingerprintHealthComplete(0, "sdrconnect")).toBe(false);
    await monitor.stop();
  });

  it("keeps missing startup fingerprint metadata out of qualification faults until warm-up ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = await temporaryConfig("fingerprint-warmup");
    const monitor = new MonitorService(config);
    const internal = monitor as unknown as {
      config: { dataDomain: "field" | "test" };
      receiverStates: Array<{
        deviceName?: string;
        deviceSerial?: string;
        apiVersion?: string;
        deviceReady: boolean;
        streamReady: boolean;
        confirmedSampleRateHz?: number;
      }>;
      receiverMetrics: Map<number, {
        overload: boolean;
        activeAntenna?: string;
        gainProfileId?: string;
        lnaState?: string;
        spectrumReference?: number;
        spectrumBase?: number;
      }>;
      commissioningStartedAtMonotonicMs: number;
      commissioningStartedAtWallMs: number;
    };
    internal.config.dataDomain = "field";
    Object.assign(internal.receiverStates[0], {
      deviceName: "RSPdx",
      deviceSerial: "RSPDX-TEST-0001",
      apiVersion: "1.0.3",
      deviceReady: true,
      streamReady: true,
      confirmedSampleRateHz: config.sampleRateHz,
    });

    expect(monitor.getCommissioningHealth()).toMatchObject({
      state: "rf-flow-ready",
      ready: false,
      soakElapsedMs: 0,
      faults: [],
    });

    internal.commissioningStartedAtMonotonicMs = performance.now() - 1;
    internal.commissioningStartedAtWallMs = Date.now() - 1;
    expect(monitor.getCommissioningHealth()).toMatchObject({
      state: "invalidated",
      ready: false,
      faults: ["rf-fingerprint-metadata-unavailable"],
    });

    internal.receiverMetrics.set(0, {
      overload: false,
      activeAntenna: "Antenna A",
      gainProfileId: "lna:0",
      lnaState: "0",
      spectrumReference: -20,
      spectrumBase: -145,
    });
    expect(monitor.getCommissioningHealth()).toMatchObject({
      state: "qualifying",
      ready: false,
      faults: [],
    });
  });
});

describe("alert sensitivity applies live and incidents explain themselves", () => {
  type Internal = {
    stopSimulation(): void;
    handleSpectrum(receiverId: number, bins: Uint8Array, source: "simulation"): void;
    activeEventsByTarget: Map<string, DetectionEvent>;
    events: DetectionEvent[];
    configurationEpoch: number;
    detector: unknown;
    evidence: { currentSession?: { id: string }; flush(): Promise<void> };
    upsertEvent(receiverId: number, targetId: string, candidate: Omit<DetectionEvent, "id" | "sessionId" | "notes">): DetectionEvent;
  };

  function candidate(targetId: string, overrides: Partial<DetectionEvent> = {}): Omit<DetectionEvent, "id" | "sessionId" | "notes"> {
    return {
      dataDomain: "test", kind: "narrowband-spike", detailKind: "narrowband", status: "interference-likely", severity: "low", evidenceStrength: "Low",
      evidenceBasis: "Relative RF anomaly from an unapproved or provisional baseline.", baselineFingerprintId: "f".repeat(64), ruleSetId: "rf-relative-mad-v1",
      observationId: "observation-1", service: "startrack", bandId: "startrack-410-470", targetId, bandLabel: "StarTrack", affectedRangeHz: [406_000_000, 414_000_000],
      disturbedRangesHz: [[409_000_000, 409_100_000]], observed: "Raised narrowband energy stayed above its usual level.", recommendedAction: "Keep recording.",
      startedAt: "2026-08-20T12:00:00.000Z", lastSeenAt: "2026-08-20T12:00:00.000Z", lifecycle: "active",
      metrics: { timestamp: "2026-08-20T12:00:00.000Z", bandId: "startrack-410-470", meanLevel: 30, peakLevel: 90, baselineLevel: 30, baselineDelta: 0, occupiedRatio: 0.01, overload: false },
      ...overrides,
    };
  }

  it("keeps an open incident when sensitivity changes, records why, and never retunes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("live-sensitivity"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as Internal;
    internal.stopSimulation();
    const targetId = "startrack-target";
    const event = internal.upsertEvent(0, targetId, candidate(targetId));
    await internal.evidence.flush();
    const firstSession = internal.evidence.currentSession!.id;
    const epoch = internal.configurationEpoch;
    const detector = internal.detector;

    const settings = structuredClone(config.operationalSettings);
    settings.revision += 1;
    settings.alerting.default = { preset: "sensitive", values: { ...settings.alerting.default.values } };
    await monitor.applyLiveSettings(withOperationalSettings(config, settings), ["alerting.default.preset"]);

    expect(event.lifecycle).toBe("active");
    expect(internal.activeEventsByTarget.get(targetId)).toBe(event);
    expect(event.timeline?.map((entry) => entry.code)).toContain("sensitivity-changed");
    expect(event.timeline?.at(-1)?.detail).toContain("Sensitive");
    expect(internal.configurationEpoch).toBe(epoch);
    expect(internal.detector).toBe(detector);
    expect(internal.evidence.currentSession!.id).not.toBe(firstSession);
    expect(event.sessionIds).toEqual(expect.arrayContaining([firstSession, internal.evidence.currentSession!.id]));
    expect(monitor.alertPolicyFor(targetId).choice).toBe("sensitive");

    const retune = structuredClone(settings);
    retune.scan.dwellMs.startrack += 1_000;
    await expect(monitor.applyLiveSettings(withOperationalSettings(config, retune), ["scan.dwellMs.startrack"])).rejects.toThrow(/receiver restart/);
    await monitor.stop();
  });

  it("keeps one incident when the raised energy changes shape, preserving the first trigger; overload starts its own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const config = enableSingleRadioTarget(await temporaryConfig("incident-merge"));
    const monitor = new MonitorService(config);
    await monitor.start();
    const internal = monitor as unknown as Internal;
    internal.stopSimulation();
    const targetId = "startrack-target";
    const firstTrigger = {
      schemaVersion: 1, detailKind: "narrowband", firedAt: "2026-08-20T12:00:00.000Z",
      measured: { peakZ: 12, medianZ: 0, occupancyRatio: 0.01, widestSegmentRatio: 0.01, widestSegmentMedianZ: 12, peakLevel: 90, usualLevelAtPeak: 30, levelAboveUsual: 60 },
    } as unknown as DetectionEvent["trigger"];
    const first = internal.upsertEvent(0, targetId, candidate(targetId, { trigger: firstTrigger }));
    const second = internal.upsertEvent(0, targetId, candidate(targetId, {
      kind: "wideband-noise-rise",
      detailKind: "partial-band",
      trigger: { ...firstTrigger!, detailKind: "partial-band", measured: { ...firstTrigger!.measured, peakZ: 20, widestSegmentRatio: 0.25 } },
      lastSeenAt: "2026-08-20T12:00:06.000Z",
      disturbedRangesHz: [[408_000_000, 410_000_000]],
      observed: "Raised RF energy over 2.0 MHz.",
    }));
    expect(second).toBe(first);
    expect(first).toMatchObject({ detailKind: "partial-band", kind: "wideband-noise-rise", startedAt: "2026-08-20T12:00:00.000Z", trigger: firstTrigger });
    expect(first.disturbedRangesHz).toEqual([[408_000_000, 410_000_000]]);
    expect(first.timeline?.map((entry) => entry.code)).toEqual(["alert", "kind-escalated"]);
    expect(first.peak).toMatchObject({ maxPeakZ: 20, maxWidestSegmentRatio: 0.25, maxLevelAboveUsual: 60 });

    const overload = internal.upsertEvent(0, targetId, candidate(targetId, { kind: "overload", detailKind: "overload", status: "suspicious", observed: "Receiver input is overloaded. Readings may be wrong." }));
    expect(overload.id).not.toBe(first.id);
    expect(first.lifecycle).toBe("cleared");
    await monitor.stop();
  });
});
