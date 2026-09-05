import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiagnosticCounter, HealthSnapshotV2, MetricWindow, TargetTimingHealth } from "../src/shared/types";
import { SystemHealthPanel } from "../src/client/SystemHealth";
import type { UseDiagnosticsResult } from "../src/client/useDiagnostics";
import {
  appendDiagnosticsTrend,
  buildDiagnosticsModel,
  diagnosticsTrendSample,
  isHealthSnapshotV2,
  redactDiagnostics,
  type DiagnosticsTrendSample,
} from "../src/client/diagnosticsModel";

const counter = (total = 0, delta10s = 0, delta60s = 0): DiagnosticCounter => ({ total, delta10s, delta60s });
const metric = (current = 0, unit: MetricWindow["unit"] = "percent"): MetricWindow => ({ unit, current, average10s: current, average60s: current, peak10s: current, peak60s: current, sampleCount: 1 });

function targetTiming(targetId: string): TargetTimingHealth {
  return {
    commissioningEpochId: "commissioning-test",
    targetId,
    objectiveMs: 2_000,
    revisitMs: { samples: 0 },
    unobservedGapMs: { samples: 0 },
    revisitHistogram: { boundsMs: [], counts: [], overflow: 0, samples: 0 },
    unobservedGapHistogram: { boundsMs: [], counts: [], overflow: 0, samples: 0 },
    validCompletions: 0,
    validRevisits: 0,
    objectiveMetRevisits: 0,
    objectiveMissedRevisits: 0,
    objectiveBreaches: 0,
    completedVisits: 0,
    unknownVisits: 0,
    missedObjectives: 0,
    missesByCause: {},
    unknownsByCause: {},
  };
}

function healthFixture(): HealthSnapshotV2 {
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-22T12:00:00.000Z",
    identity: {
      schemaVersion: 1,
      serviceBootId: "00000000-0000-4000-8000-000000000001",
      serviceStartedAt: "2026-08-22T00:00:00.000Z",
      nodeVersion: "v22.0.0",
      release: {
        schemaVersion: 1,
        product: "rf-monitor",
        releaseVersion: "1.0.0",
        buildId: "release-test",
        serverBuildId: "release-test",
        clientBuildId: "release-test",
        sourceDigest: "a".repeat(64),
        packageDigest: "b".repeat(64),
        dependencyLockDigest: "c".repeat(64),
        integrity: "release-metadata",
      },
      protocols: { health: 2, live: 2, evidenceManifest: 2, catalogSchema: 4, operationalSchema: 4 },
      configuration: { catalogVersion: "catalog-v3", configurationHash: "d".repeat(64), configurationRevision: 1, detectorRuleSetId: "rf-relative-mad-v1", expectedSampleRateHz: 10_000_000 },
    },
    currentHealth: { state: "normal", ready: true, monitoringReady: true, evidenceReady: true, issueCount: 0, evaluatedAt: "2026-08-22T12:00:00.000Z" },
    productionQualification: {
      schemaVersion: 1,
      epochId: "qualification-test",
      fingerprint: "e".repeat(64),
      state: "qualified",
      ready: true,
      startedAt: "2026-08-22T11:00:00.000Z",
      updatedAt: "2026-08-22T12:00:00.000Z",
      releaseBuildId: "release-test",
      configurationHash: "d".repeat(64),
      commissioningEpochId: "commissioning-test",
      blockers: [],
      faults: [],
      requirements: { immutableRelease: true, clientServerBuildMatch: true, productionSampleRate: true, sampleRateConfirmed: true, physicalReceiver: true, supportedReceiverModel: true, stableReceiverIdentity: true, protectedBaselines: true, scanObjectives: true, cleanResourceSoak: true, soakComplete: true, externalApproval: true, installedChainQualified: true, timingAndBaselineQualified: true, hardwareRecoveryQualified: true, faultQualification: true, evidenceContinuityQualified: true, clean72HourSoakQualified: false, controlledPilotQualified: false },
    },
    productionQualificationHistory: [],
    productionReady: true,
    summary: { state: "normal", issues: [] },
    receiverPath: {
      availability: { state: "available" },
      expectedSampleRateHz: 10_000_000,
      receivers: [{ id: 0, usb: "present", transport: "connected", frames: "live", confirmedSampleRateHz: 10_000_000, activeAntenna: "Antenna A", sampleRateMatches: true, reconnectAttempts: 0, lastFrameAgeMs: 100 }],
    },
    dataContinuity: {
      receivedFrames: counter(100, 10, 60),
      analyzedObservations: counter(90, 9, 54),
      intentionalTuneGateFrames: counter(),
      intentionalTuneDiscards: counter(),
      intentionalRateCoalescing: counter(),
      invalidOrStaleFrames: counter(),
      unexpectedIqPayloads: counter(),
      unknownVisits: counter(),
      missedObjectives: counter(),
      evidenceFramesRecorded: counter(20, 2, 12),
      evidenceFramesLost: counter(),
      browserFramesCoalesced: counter(),
      browserFramesDropped: counter(),
    },
    software: {
      processCollector: { state: "available" },
      hostCollector: { state: "available" },
      rfMonitorCpuHostNormalized: metric(12),
      rfMonitorCpuCoreEquivalent: metric(24),
      hostCpu: metric(30),
      hostLoad1m: metric(0.5, "load"),
      rssBytes: 128 * 1024 * 1024,
      heapUsedBytes: 64 * 1024 * 1024,
      heapLimitBytes: 384 * 1024 * 1024,
      externalBytes: 16 * 1024 * 1024,
      arrayBufferBytes: 8 * 1024 * 1024,
      eventLoopDelayP50Ms: 5,
      eventLoopDelayP99Ms: 20,
      sdrconnect: { availability: { state: "available" }, cpuCoreEquivalent: metric(20), memoryBytes: 100 * 1024 * 1024 },
    },
    network: {
      hostCollector: { state: "available" },
      interfaces: [{
        id: "eth0",
        state: "up",
        receivedBytes: counter(1_000, 100, 600),
        transmittedBytes: counter(2_000, 200, 1_200),
        receivedBytesPerSecond: metric(100, "bytes-per-second"),
        transmittedBytesPerSecond: metric(200, "bytes-per-second"),
        receiveErrors: counter(), transmitErrors: counter(), receiveDrops: counter(), transmitDrops: counter(),
      }],
      managedSwitch: { availability: { state: "not-applicable", reasonCode: "external-not-connected" } },
      liveBytesPerSecond10s: 1_000,
      liveBytesPerSecond60s: 900,
      applicationBytesPerSecond10s: 2_000,
      applicationBytesPerSecond60s: 1_800,
      dashboards: 1,
      queuedBytes: 0,
      drops: counter(),
    },
    evidence: {
      healthy: true,
      writerQueueItems: 0,
      writerQueueBytes: 0,
      writerOldestAgeMs: 0,
      writeBytesPerSecond10s: 1_000,
      diskFreeBytes: 100 * 1024 * 1024 * 1024,
      diskReserveBytes: 10 * 1024 * 1024 * 1024,
      diskPressure: false,
      exportsActive: 0,
      exportsQueued: 0,
      baselineBytes: 10_000,
      ringBytes: 20_000,
      archive: {
        state: "normal",
        activeSessionId: "session-active",
        finalizingSessions: 0,
        incompleteSessions: 0,
        corruptSessions: 0,
        action: "open-recording",
        verificationNotRunSessions: 0,
        finalizer: {
          queueItems: 0,
          queueLimit: 8,
          oldestAgeMs: 0,
          completedTotal: 0,
          incompleteTotal: 0,
          corruptTotal: 0,
          rejectedTotal: 0,
        },
      },
    },
    schedule: {
      health: { profile: "fast-gnss", configurationEpoch: 1, tuneEpoch: 1, completedVisits: 10, unknownVisits: 0, missedObjectives: 0, tier1MeetingObjective: true, currentCoverage: { state: "on-time", windowMs: 60_000 }, optionalQualificationReady: false, optionalQualificationElapsedMs: 1_000, optionalWorkAdmitted: false, protectedReserveRatio: 0.1 },
      targets: [],
      commissioning: { epochId: "commissioning-test", state: "qualified", ready: true, receiverReady: true, sampleRateReady: true, simulation: false, dataDomain: "field", soakRequiredMs: 1_000, soakElapsedMs: 1_000, soakStartedAt: "2026-08-22T11:00:00.000Z", scanObjectiveReady: true, resourceSoakClean: true, faults: [] },
      baselines: [],
    },
  };
}

describe("diagnostics presentation model", () => {
  it("uses the authoritative summary and preserves structured issue context", () => {
    const health = healthFixture();
    health.summary = {
      state: "attention",
      issues: [{ id: "nic-drops", code: "network-interface-errors-or-drops", severity: "attention", subsystem: "network", active: true, value: 3, threshold: 0, unit: "count", count: 2, firstOccurredAt: "2026-08-22T11:59:00.000Z", lastOccurredAt: "2026-08-22T12:00:00.000Z", action: "check-switch-counters" }],
    };
    const model = buildDiagnosticsModel(health);
    expect(model).toMatchObject({ status: "warning", label: "Attention", headline: "1 item needs attention." });
    expect(model.issues[0]).toMatchObject({ cardId: "network", actionKind: "check-switch-counters", title: "Network data was dropped" });
    expect(model.issues[0].detail).toContain("3 in the last minute");
    expect(model.issues[0].detail).not.toContain("times");
    expect(model.cards.find((card) => card.id === "network")?.status).toBe("warning");
  });

  it("uses terse operator copy for host pressure and keeps raw memory data in Engineer details", () => {
    const health = healthFixture();
    health.software.hostMemory = {
      state: "critical",
      reasonCodes: ["host-memory-available-critical"],
      totalBytes: 16 * 1024 * 1024 * 1024,
      availableBytes: 1024 * 1024 * 1024,
      swapTotalBytes: 2 * 1024 * 1024 * 1024,
      swapFreeBytes: 128 * 1024 * 1024,
      availableRatio: 0.0625,
      swapFreeRatio: 0.0625,
      psiSomeAvg10: 26,
      psiFullAvg10: 2,
      recentOomKill: false,
      sampledAt: health.generatedAt,
    };
    health.summary = {
      state: "critical",
      issues: [{ id: "host-memory-critical", code: "host-memory-critical", severity: "critical", subsystem: "software", active: true, count: 1, firstOccurredAt: health.generatedAt, lastOccurredAt: health.generatedAt, action: "open-system-health" }],
    };
    health.recovery = {
      receiver: { schemaVersion: 1, outcome: "suppressed", reasonCode: "host-memory-pressure" },
      application: { schemaVersion: 1, outcome: "suppressed", reasonCode: "host-memory-pressure" },
    };

    const model = buildDiagnosticsModel(health);
    expect(model.issues[0]).toMatchObject({ title: "Computer memory is low", detail: "Close unused browser tabs." });
    expect(model.recovery).toMatchObject({ label: "Recovery paused", detail: "Waiting for computer memory." });
    expect(model.cards.find((card) => card.id === "software")?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "host-memory-state", value: "Critical" }),
      expect.objectContaining({ id: "host-memory-psi" }),
    ]));
  });

  it("reduces the default view to six task-focused operator checks", () => {
    const model = buildDiagnosticsModel(healthFixture());
    expect(model).toMatchObject({ status: "healthy", label: "Normal", headline: "Monitoring is working.", action: "No action needed." });
    expect(model.checks).toEqual([
      { id: "receiver", label: "Receiver", value: "Connected", status: "healthy" },
      { id: "confirmed-input", label: "Confirmed input", value: "Antenna A", status: "healthy" },
      { id: "rf-data", label: "RF data", value: "Live", status: "healthy" },
      { id: "recording", label: "Recording", value: "On", status: "healthy" },
      { id: "coverage", label: "Scan coverage", value: "On time", status: "healthy" },
      { id: "learning", label: "Signal learning", value: "0 of 24 hours", status: "unknown" },
    ]);
  });

  it("calculates signal learning from the newest active target baselines only", () => {
    const health = healthFixture();
    health.schedule.targets = [targetTiming("gnss-l1")];
    health.schedule.baselines = [
      { dataDomain: "field", targetId: "gnss-l1", lifecycle: "protected", fingerprintId: "old-active", learningGenerationId: "1", observationCount: 100, validCoverageRatio: 1, representativeHours: 24, learningStartedAt: "2026-08-22T10:00:00.000Z", protectedAt: "2026-08-23T10:00:00.000Z" },
      { dataDomain: "field", targetId: "gnss-l1", lifecycle: "provisional", fingerprintId: "current-active", learningGenerationId: "2", observationCount: 100, validCoverageRatio: 0.95, representativeHours: 7, learningStartedAt: "2026-08-24T10:00:00.000Z" },
      { dataDomain: "field", targetId: "rf-inactive", lifecycle: "learning", fingerprintId: "inactive", learningGenerationId: "1", observationCount: 16, validCoverageRatio: 1, representativeHours: 0, learningStartedAt: "2026-08-22T10:00:00.000Z" },
    ];

    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "learning")).toEqual({
      id: "learning",
      label: "Signal learning",
      value: "7 of 24 hours",
      status: "unknown",
    });
  });

  it("counts a missing active target baseline as zero progress", () => {
    const health = healthFixture();
    health.schedule.targets = [targetTiming("gnss-l1"), targetTiming("gnss-l2")];
    health.schedule.baselines = [{
      dataDomain: "field",
      targetId: "gnss-l1",
      lifecycle: "provisional",
      fingerprintId: "active-l1",
      learningGenerationId: "1",
      observationCount: 100,
      validCoverageRatio: 0.95,
      representativeHours: 7,
      learningStartedAt: "2026-08-24T10:00:00.000Z",
    }];

    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "learning"))
      .toMatchObject({ value: "0 of 24 hours", status: "unknown" });
  });

  it("keeps bounded learning exclusion reasons in Engineer details", () => {
    const health = healthFixture();
    health.schedule.targets = [targetTiming("gnss-l1")];
    health.schedule.baselines = [{
      dataDomain: "field",
      targetId: "gnss-l1",
      lifecycle: "provisional",
      fingerprintId: "current-active",
      learningGenerationId: "2",
      observationCount: 100,
      validCoverageRatio: 0.95,
      representativeHours: 7,
      learningStartedAt: "2026-08-24T10:00:00.000Z",
      learningExclusions: {
        rejectedVisits: 4,
        rejectedByReason: { "anomaly-candidate": 3, "insufficient-frames": 1 },
        disqualifiedHours: 1,
        disqualifiedByReason: { "legacy-unclassified": 1 },
      },
    }];

    expect(buildDiagnosticsModel(health).cards.find((card) => card.id === "schedule")?.rows)
      .toContainEqual(expect.objectContaining({
        id: "learning-exclusions",
        value: "4 rejected visits · 1 excluded hour",
        detail: expect.stringContaining("Legacy unclassified hours 1"),
      }));
  });

  it("shows confirmed antenna read-back without exposing an input selector", () => {
    const health = healthFixture();
    health.receiverPath.receivers[0].activeAntenna = "Antenna B";
    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "confirmed-input")).toMatchObject({ value: "Antenna B", status: "healthy" });
    expect(buildDiagnosticsModel(health).cards.find((card) => card.id === "receiver")?.rows.find((row) => row.id === "0-input")).toMatchObject({ value: "Antenna B", status: "healthy" });

    delete health.receiverPath.receivers[0].activeAntenna;
    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "confirmed-input")).toMatchObject({ value: "Checking", status: "unknown" });
  });

  it("keeps current health independent without adding a generic qualification checklist", () => {
    const health = healthFixture();
    health.productionReady = false;
    health.productionQualification = {
      ...health.productionQualification,
      state: "failed",
      ready: false,
      blockers: ["fault:resource-critical", "receiver-model-unsupported", "baseline-pending", "external-qualification-approval-missing"],
      faults: [{ code: "resource-critical", count: 1, firstOccurredAt: health.generatedAt, lastOccurredAt: health.generatedAt }],
    };
    const model = buildDiagnosticsModel(health);
    expect(model.status).toBe("healthy");
    const diagnostics: UseDiagnosticsResult = {
      health,
      trend: [],
      model,
      loading: false,
      refreshing: false,
      lastSuccessfulAt: Date.parse(health.generatedAt),
      refresh: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(SystemHealthPanel, { diagnostics }));
    expect(markup).toContain("Monitoring is working.");
    expect(markup).not.toContain("Correct recorded qualification faults.");
    expect(markup).not.toContain("Confirm the frozen receiver and RF chain.");
    expect(markup).not.toContain("Complete signal learning and the live field run.");
    expect(markup).not.toContain("Complete remaining V0–V7 checks and approval.");
  });

  it("uses recent scan health for the operator while retaining epoch qualification history", () => {
    const health = healthFixture();
    health.schedule.health.tier1MeetingObjective = false;
    health.schedule.health.tier1ValidRevisits = 8_000;
    health.schedule.health.missedObjectives = 25;

    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "coverage")).toMatchObject({ value: "On time", status: "healthy" });

    health.schedule.health.currentCoverage = { state: "late", windowMs: 60_000, targetId: "gnss-gps-l2c", objectiveMs: 6_000, measuredRevisitMs: 6_500, cause: "recent-objective-miss" };
    const lateModel = buildDiagnosticsModel(health);
    expect(lateModel.checks.find((check) => check.id === "coverage")).toMatchObject({ value: "Late", status: "warning" });
    expect(lateModel.issues.find((issue) => issue.family === "coverage")).toMatchObject({
      title: "A scan was late",
      detail: "Gnss gps l2c returned later than planned · objective 6.0 s · measured 6.5 s",
      actionKind: "open-monitoring",
    });
    expect(lateModel.cards.find((card) => card.id === "schedule")?.rows.find((row) => row.id === "current-coverage")?.detail).toContain("Recent objective miss");

    health.schedule.health.currentCoverage = { state: "checking", windowMs: 60_000, targetId: "gnss-gps-l2c", cause: "recent-unknown-visit" };
    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "coverage")).toMatchObject({ value: "Checking", status: "unknown" });
  });

  it("keeps dashboard delivery faults actionable without exposing a support command first", () => {
    const health = healthFixture();
    health.summary = {
      state: "attention",
      issues: [{ id: "browser-loss", code: "browser-delivery-loss", severity: "attention", subsystem: "data", active: true, value: 4, threshold: 0, unit: "count", count: 1, firstOccurredAt: health.generatedAt, lastOccurredAt: health.generatedAt, action: "check-switch-counters" }],
    };
    expect(buildDiagnosticsModel(health).issues[0]).toMatchObject({
      title: "Dashboard data was dropped",
      action: "Reload this dashboard.",
      actionKind: "reload-dashboard",
      detail: "4 in the last minute · limit 0",
    });
  });

  it("keeps trends, raw counters, and support tools in collapsed Engineer details", () => {
    const health = healthFixture();
    const diagnostics: UseDiagnosticsResult = {
      health,
      trend: [],
      model: buildDiagnosticsModel(health),
      loading: false,
      refreshing: false,
      lastSuccessfulAt: Date.parse(health.generatedAt),
      refresh: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(SystemHealthPanel, { diagnostics }));
    const engineerStart = markup.indexOf('<details class="advanced-settings-group">');
    expect(markup.match(/class="settings-fact normal"/g)).toHaveLength(5);
    expect(markup.match(/class="settings-fact"/g)).toHaveLength(1);
    expect(engineerStart).toBeGreaterThan(-1);
    expect(markup).not.toContain('<details class="advanced-settings-group" open=""');
    expect(markup.indexOf("Last 10 minutes")).toBeGreaterThan(engineerStart);
    expect(markup.indexOf("Frames received")).toBeGreaterThan(engineerStart);
    expect(markup.indexOf("Copy doctor command")).toBeGreaterThan(engineerStart);
  });

  it("marks every physical receiver stage Not tested in simulation", () => {
    const health = healthFixture();
    health.summary.state = "simulation";
    health.schedule.commissioning.simulation = true;
    const model = buildDiagnosticsModel(health);
    const physicalRows = model.cards.find((card) => card.id === "receiver")?.rows.filter((row) => /usb|transport|frames|input/.test(row.id)) ?? [];
    const sdrconnectRows = model.cards.find((card) => card.id === "software")?.rows.filter((row) => row.id.startsWith("sdr-")) ?? [];
    expect(model.label).toBe("Simulation");
    expect(model.checks.slice(0, 2).map((check) => check.value)).toEqual(["Not tested", "Not tested"]);
    expect(model.checks.slice(0, 2).every((check) => check.status === "not-tested")).toBe(true);
    expect(physicalRows).toHaveLength(4);
    expect(physicalRows.every((row) => row.status === "not-tested" && row.value === "Not tested")).toBe(true);
    expect(sdrconnectRows).toHaveLength(2);
    expect(sdrconnectRows.every((row) => row.status === "not-tested" && row.value === "Not tested")).toBe(true);
  });

  it("separates real loss from intentional skips in the recording check", () => {
    const health = healthFixture();
    health.dataContinuity.intentionalTuneDiscards = counter(1_000, 10, 60);
    health.dataContinuity.intentionalRateCoalescing = counter(1_000, 10, 60);
    expect(buildDiagnosticsModel(health).checks.find((check) => check.id === "recording")).toMatchObject({ value: "On", status: "healthy" });

    health.dataContinuity.browserFramesDropped = counter(2, 1, 2);
    const browserLoss = buildDiagnosticsModel(health);
    expect(browserLoss.checks.find((check) => check.id === "rf-data")).toMatchObject({ value: "Check data", status: "warning" });
    expect(browserLoss.checks.find((check) => check.id === "recording")).toMatchObject({ value: "On", status: "healthy" });

    health.dataContinuity.evidenceFramesLost = counter(1, 1, 1);
    const model = buildDiagnosticsModel(health);
    expect(model.checks.find((check) => check.id === "recording")).toMatchObject({ value: "Data lost", status: "critical" });
  });

  it("deduplicates related receiver faults and keeps occurrence context and recovery boundaries", () => {
    const health = healthFixture();
    health.summary = {
      state: "critical",
      issues: [
        { id: "receiver-path", code: "receiver-path-unavailable", severity: "critical", subsystem: "receiver", active: true, count: 2, firstOccurredAt: "2026-08-22T11:00:00.000Z", lastOccurredAt: "2026-08-22T11:55:00.000Z", action: "retry-receiver" },
        { id: "receiver-recovery", code: "receiver-recovery-failed", severity: "critical", subsystem: "receiver", active: true, count: 3, firstOccurredAt: "2026-08-22T11:30:00.000Z", lastOccurredAt: "2026-08-22T12:00:00.000Z", action: "retry-receiver" },
      ],
    };
    const model = buildDiagnosticsModel(health);
    expect(model.issues).toHaveLength(1);
    expect(model.issues[0]).toMatchObject({
      family: "receiver",
      count: 5,
      lastOccurredAt: "2026-08-22T12:00:00.000Z",
      actionKind: "retry-receiver",
      codes: expect.arrayContaining(["receiver-path-unavailable", "receiver-recovery-failed"]),
      guidance: {
        success: expect.stringContaining("RF data show Live"),
        stop: expect.stringContaining("one retry"),
      },
    });
  });

  it("creates task guidance for live data, receiver overload, and stale signal learning", () => {
    const health = healthFixture();
    health.schedule.baselines = [{
      dataDomain: "field", targetId: "gnss-l1", lifecycle: "stale", fingerprintId: "f".repeat(64), learningGenerationId: "1", observationCount: 10, validCoverageRatio: 1, representativeHours: 5, learningStartedAt: health.generatedAt,
    }];
    health.schedule.targets = [targetTiming("gnss-l1")];
    const snapshot = {
      generatedAt: health.generatedAt,
      operatorSummary: { monitoring: { state: "data-late" } },
      currentMetrics: { overload: true },
    } as unknown as import("../src/shared/types").MonitorSnapshot;
    const model = buildDiagnosticsModel(health, snapshot);
    expect(model.status).toBe("warning");
    expect(model.issues.map((issue) => issue.family)).toEqual(["data-late", "overload", "learning"]);
    expect(model.issues.find((issue) => issue.family === "data-late")?.actionKind).toBe("reload-dashboard");
    expect(model.issues.find((issue) => issue.family === "learning")?.actionKind).toBe("open-advanced");
    expect(model.checks).toEqual(expect.arrayContaining([
      { id: "receiver", label: "Receiver", value: "Overloaded", status: "warning" },
      { id: "rf-data", label: "RF data", value: "Data late", status: "warning" },
      { id: "learning", label: "Signal learning", value: "Paused", status: "warning" },
    ]));
  });

  it("keeps receiver overload and computer overload as separate actionable causes", () => {
    const health = healthFixture();
    health.summary = {
      state: "critical",
      issues: [{ id: "host-critical", code: "host-cpu-event-loop-critical", severity: "critical", subsystem: "software", active: true, value: 98, threshold: 95, unit: "percent", count: 2, firstOccurredAt: health.generatedAt, lastOccurredAt: health.generatedAt, action: "open-system-health" }],
    };
    const snapshot = {
      generatedAt: health.generatedAt,
      operatorSummary: { monitoring: { state: "normal" } },
      currentMetrics: { overload: true },
    } as unknown as import("../src/shared/types").MonitorSnapshot;
    const issues = buildDiagnosticsModel(health, snapshot).issues;
    expect(issues.map((issue) => issue.family)).toEqual(["system", "overload"]);
    expect(issues.find((issue) => issue.family === "system")?.guidance.steps).toContain("Stop unnecessary dashboards or exports.");
    expect(issues.find((issue) => issue.family === "overload")?.guidance.steps).toContain("Check the approved antenna and gain setup.");
  });

  it("shows bounded recovery progress, external verification, and lockout truthfully", () => {
    const health = healthFixture();
    health.recovery = {
      receiver: { schemaVersion: 1, outcome: "unavailable", reasonCode: "missing" },
      application: { schemaVersion: 1, outcome: "helper-pending", reasonCode: "request-published", requestId: "restart-1", requestedAt: health.generatedAt },
    };
    expect(buildDiagnosticsModel(health).recovery).toMatchObject({ state: "progress", label: "Software restart in progress", detail: "Waiting for the external health check." });

    health.recovery.application = { ...health.recovery.application, outcome: "verified-recovery", reasonCode: "restart-confirmed" };
    expect(buildDiagnosticsModel(health).recovery).toMatchObject({ state: "verified", detail: expect.stringContaining("Check RF data and Recording") });

    health.recovery.application = { ...health.recovery.application, outcome: "lockout", reasonCode: "attempt-limit" };
    expect(buildDiagnosticsModel(health)).toMatchObject({ status: "warning", recovery: { state: "attention", detail: expect.stringContaining("locked") } });
  });

  it("redacts secrets, identities, addresses, paths, and MAC addresses", () => {
    expect(redactDiagnostics({
      password: "open-sesame",
      siteName: "Harbor North",
      storagePath: "/var/lib/rf-monitor/evidence",
      url: "http://192.168.1.9:5454/path",
      note: "peer 10.0.0.5 used 00:11:22:33:44:55; log /var/log/rf-monitor.log",
    })).toEqual({
      password: "[redacted]",
      siteName: "[redacted-identity]",
      storagePath: "[redacted-path]",
      url: "[redacted-address]",
      note: "peer [redacted-ip] used [redacted-mac]; log [redacted-path]",
    });
  });

  it("keeps at most 300 samples and only the latest ten minutes", () => {
    let trend: DiagnosticsTrendSample[] = [];
    for (let index = 0; index <= 300; index += 1) trend = appendDiagnosticsTrend(trend, { at: index * 2_000, cpuPercent: index });
    expect(trend).toHaveLength(300);
    expect(trend[0].at).toBe(2_000);
    trend = appendDiagnosticsTrend(trend, { at: 1_300_000, cpuPercent: 1 });
    expect(trend).toEqual([{ at: 1_300_000, cpuPercent: 1 }]);
  });

  it("extracts the bounded trend fields only from schema v2", () => {
    const health = healthFixture();
    expect(isHealthSnapshotV2(health)).toBe(true);
    expect(isHealthSnapshotV2({ generatedAt: health.generatedAt })).toBe(false);
    expect(diagnosticsTrendSample(health, 42)).toEqual({ at: 42, cpuPercent: 12, rssBytes: 128 * 1024 * 1024, bandwidthBytesPerSecond: 2_000, lossPercent: 0, writerDelayMs: 0 });
  });
});
