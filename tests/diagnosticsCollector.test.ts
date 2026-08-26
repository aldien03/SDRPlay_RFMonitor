import { describe, expect, it } from "vitest";
import {
  DEFAULT_SDRCONNECT_CGROUP_PATH,
  DiagnosticCounterWindow,
  DiagnosticsCollector,
} from "../src/server/diagnosticsCollector";
import type { DiagnosticsRuntimeSample } from "../src/server/diagnosticsCollector";

function runtime(overrides: Partial<DiagnosticsRuntimeSample> = {}): DiagnosticsRuntimeSample {
  return {
    generatedAt: "2026-08-22T00:00:00.000Z",
    simulation: false,
    expectedSampleRateHz: 10_000_000,
    receivers: [{
      id: 0,
      url: "ws://127.0.0.1:5454",
      connection: "live",
      hardwareState: "present",
      transportState: "connected",
      streamState: "live",
      streamReady: true,
      deviceReady: true,
      confirmedSampleRateHz: 10_000_000,
      reconnectAttempts: 0,
    }],
    processing: {
      spectrumFramesReceived: 0,
      spectrumFramesAnalyzed: 0,
      spectrumFramesDropped: 0,
      tuneGateFramesIgnored: 0,
      tuneFramesDiscarded: 0,
      rateCoalescedFrames: 0,
      invalidSpectrumFramesDropped: 0,
      acceptedAttributionInvariantViolations: 0,
      unexpectedIqPayloadsDropped: 0,
      evidenceFramesRecorded: 0,
      evidenceFramesDropped: 0,
      evidenceWritesInFlight: 0,
      maxSpectrumRateHz: 4,
      maxSpectrumBins: 2_048,
      evidenceFrameIntervalMs: 2_000,
    },
    scheduler: {
      profile: "fast-gnss",
      configurationEpoch: 1,
      tuneEpoch: 1,
      completedVisits: 0,
      unknownVisits: 0,
      missedObjectives: 0,
      optionalQualificationReady: false,
      optionalQualificationElapsedMs: 0,
      optionalWorkAdmitted: false,
      protectedReserveRatio: 0.1,
    },
    commissioning: {
      epochId: "00000000-0000-4000-8000-000000000001",
      state: "qualifying",
      ready: false,
      receiverReady: true,
      sampleRateReady: true,
      simulation: false,
      dataDomain: "field",
      soakRequiredMs: 24 * 60 * 60_000,
      soakElapsedMs: 0,
      soakStartedAt: "2026-08-22T00:00:00.000Z",
      scanObjectiveReady: false,
      resourceSoakClean: true,
      faults: [],
    },
    streaming: {
      clients: 0,
      outboundBytes: 0,
      outboundBytesPerSecond: 0,
      outboundBytesPerSecond10s: 0,
      outboundBytesPerSecond60s: 0,
      spectrumMessages: 0,
      coalescedFrames: 0,
      slowClientDrops: 0,
      budgetDrops: 0,
      duplicateSubscriptions: 0,
      rejectedClients: 0,
      maxBufferedBytes: 0,
      startedAt: "2026-08-22T00:00:00.000Z",
    },
    resources: {
      state: "normal",
      rssBytes: 100_000_000,
      heapUsedBytes: 20_000_000,
      heapLimitBytes: 384_000_000,
      heapUtilization: 0.052,
      externalBytes: 1_000,
      arrayBuffersBytes: 1_000,
      eventLoopDelayP50Ms: 1,
      eventLoopDelayP99Ms: 2,
      writerQueueItems: 0,
      writerQueueBytes: 0,
      writerOldestAgeMs: 0,
      diskWriteBytesPerSecond10s: 0,
      diskFreeBytes: 1_000_000_000,
      exportsActive: 0,
      exportsQueued: 0,
      baselineBytes: 0,
      ringBytes: 0,
      dashboardsStatusOnly: false,
    },
    evidenceHealthy: true,
    evidenceArchive: {
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
    diskPressure: false,
    ...overrides,
  };
}

function fixture() {
  let step = 0;
  let wall = 1_700_000_000_000;
  let monotonic = 0;
  let receiveErrors = 0;
  const readText = async (filePath: string): Promise<string> => {
    if (filePath === "/proc/stat") return `cpu  ${90 * step + 20} 0 0 ${10 * step + 80} 0 0 0 0 0 0\n`;
    if (filePath === "/proc/loadavg") return "1.25 0.75 0.50 1/100 1\n";
    if (filePath.endsWith("/operstate")) return "up\n";
    if (filePath.endsWith("/rx_bytes")) return String(1_000 + step * 500);
    if (filePath.endsWith("/tx_bytes")) return String(2_000 + step * 250);
    if (filePath.endsWith("/rx_errors")) return String(receiveErrors);
    if (filePath.endsWith("/tx_errors") || filePath.endsWith("/rx_dropped") || filePath.endsWith("/tx_dropped")) return "0\n";
    if (filePath.endsWith("/cpu.stat")) return `usage_usec ${step * 500_000}\n`;
    if (filePath.endsWith("/memory.current")) return "104857600\n";
    throw new Error(`Unexpected fixture path: ${filePath}`);
  };
  const collector = new DiagnosticsCollector({
    sources: {
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      processCpuUsage: () => ({ user: step * 1_800_000, system: 0 }),
      coreCount: () => 2,
      platform: () => "linux",
      readText,
      listDirectory: async () => ["lo", "eth0"],
    },
  });
  return {
    collector,
    advance() { step += 1; wall += 1_000; monotonic += 1_000; },
    setReceiveErrors(value: number) { receiveErrors = value; },
  };
}

describe("bounded diagnostics collector", () => {
  it("uses the installed SDRconnect headless cgroup by default", () => {
    expect(DEFAULT_SDRCONNECT_CGROUP_PATH).toBe("/sys/fs/cgroup/system.slice/sdrconnect-headless.service");
  });

  it("handles monotonic counters, including a source reset", () => {
    const counter = new DiagnosticCounterWindow();
    counter.update(100, 0);
    counter.update(105, 1_000);
    counter.update(2, 2_000);
    expect(counter.snapshot(2_000)).toMatchObject({ total: 107, delta10s: 7, delta60s: 7 });
  });

  it("samples process, host, cgroup, NIC, and separated continuity counters", async () => {
    const test = fixture();
    await test.collector.sample(runtime());
    test.advance();
    test.setReceiveErrors(1);
    const next = runtime({
      processing: { ...runtime().processing, spectrumFramesReceived: 10, spectrumFramesAnalyzed: 3, tuneGateFramesIgnored: 4, tuneFramesDiscarded: 2, rateCoalescedFrames: 1, invalidSpectrumFramesDropped: 1 },
      streaming: { ...runtime().streaming, coalescedFrames: 5, slowClientDrops: 1 },
      scheduler: { ...runtime().scheduler, missedObjectives: 1 },
    });
    await test.collector.sample(next);
    const snapshot = test.collector.snapshot();
    expect(snapshot.processCollector.state).toBe("available");
    expect(snapshot.hostCollector.state).toBe("available");
    expect(snapshot.sdrconnect).toMatchObject({ availability: { state: "available" }, memoryBytes: 104_857_600 });
    expect(snapshot.rfMonitorCpuHostNormalized.current).toBe(90);
    expect(snapshot.hostCpu.current).toBe(90);
    expect(snapshot.networkInterfaces[0]).toMatchObject({ id: "eth0", state: "up" });
    expect(snapshot.networkInterfaces[0].receivedBytesPerSecond.current).toBe(500);
    expect(snapshot.dataContinuity).toMatchObject({
      receivedFrames: { delta10s: 10 },
      analyzedObservations: { delta10s: 3 },
      intentionalTuneGateFrames: { delta10s: 4 },
      intentionalTuneDiscards: { delta10s: 2 },
      intentionalRateCoalescing: { delta10s: 1 },
      invalidOrStaleFrames: { delta10s: 1 },
      browserFramesCoalesced: { delta10s: 5 },
      browserFramesDropped: { delta10s: 1 },
    });
    expect(snapshot.summary.issues.map((issue) => issue.code)).toContain("network-interface-errors-or-drops");
    expect(snapshot.summary.issues.map((issue) => issue.code)).toContain("schedule-objective-missed");
  });

  it("does not flag sustained CPU thresholds until the 60-second window is populated", async () => {
    const test = fixture();
    for (let index = 0; index < 54; index += 1) {
      await test.collector.sample(runtime());
      test.advance();
    }
    expect(test.collector.snapshot().summary.issues.map((issue) => issue.code)).not.toContain("host-cpu-high");
    for (let index = 0; index < 2; index += 1) {
      await test.collector.sample(runtime());
      test.advance();
    }
    expect(test.collector.snapshot().summary.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["host-cpu-high", "rf-monitor-cpu-high"]));
  });

  it("reports simulation without claiming physical hardware health", async () => {
    const test = fixture();
    const simulated = runtime({
      simulation: true,
      receivers: [{ id: 0, url: "simulation://local", connection: "simulated", streamReady: true, deviceReady: true }],
      commissioning: { ...runtime().commissioning, state: "simulation", simulation: true, receiverReady: true },
    });
    await test.collector.sample(simulated);
    expect(test.collector.snapshot().summary).toMatchObject({ state: "simulation", issues: [] });
  });

  it("reports historical incomplete or corrupt evidence as one actionable attention issue", async () => {
    const test = fixture();
    const archive = runtime().evidenceArchive;
    await test.collector.sample(runtime({
      evidenceHealthy: true,
      evidenceArchive: {
        ...archive,
        state: "attention",
        incompleteSessions: 2,
        corruptSessions: 1,
        issueSessionId: "session-old",
      },
    }));
    expect(test.collector.snapshot().summary.issues.filter((issue) => issue.code === "evidence-archive-needs-attention")).toEqual([
      expect.objectContaining({ severity: "attention", subsystem: "evidence", value: 3, action: "open-recording" }),
    ]);
    expect(test.collector.snapshot().summary.issues.map((issue) => issue.code)).not.toContain("evidence-unavailable");
  });

  it("degrades unavailable Linux collectors without failing the health snapshot", async () => {
    const collector = new DiagnosticsCollector({
      sources: {
        wallNow: () => 1_700_000_000_000,
        monotonicNow: () => 0,
        processCpuUsage: () => ({ user: 0, system: 0 }),
        coreCount: () => 1,
        platform: () => "linux",
        readText: async () => { throw new Error("not mounted"); },
        listDirectory: async () => { throw new Error("not mounted"); },
      },
    });
    await collector.sample(runtime());
    expect(collector.snapshot()).toMatchObject({
      hostCollector: { state: "unavailable", reasonCode: "procfs-unavailable" },
      networkCollector: { state: "unavailable", reasonCode: "sysfs-network-unavailable" },
      sdrconnect: { availability: { state: "unavailable", reasonCode: "sdrconnect-cgroup-unavailable" } },
    });
  });
});
