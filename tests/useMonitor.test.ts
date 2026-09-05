import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptCanonicalControlMessage,
  applyAcceptedCanonicalControl,
  appendWaterfallFrame,
  applyCanonicalStateDelta,
  baselineRestartRequiresRecovery,
  CanonicalStateFreshnessWatchdog,
  clientBuildMatches,
  HIDDEN_HISTORY_RELEASE_MS,
  LiveConnectionGenerations,
  MAX_CLIENT_WATERFALL_ROWS,
  snapshotWithBuildMismatch,
  snapshotWithInvalidOperatorState,
  snapshotWithClientDataLate,
} from "../src/client/useMonitor";
import { resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { MonitorSnapshot, SpectrumFrame } from "../src/shared/types";

const operatorSummary = resolveOperatorSummary({
  generatedAt: "2026-08-23T08:00:00.000Z",
  serverBuildId: "release-a",
  dataDomain: "field",
  monitoring: {
    receiverOnline: true,
    dataFresh: true,
    paused: false,
    alertActive: true,
    recovering: false,
    candidateActive: false,
    detectingActive: false,
    checking: false,
  },
  incident: {
    id: "incident-kept",
    lifecycle: "active",
    verdict: "Suspected RF interference",
    observation: "Signal above normal",
    recommendedAction: "Check navigation sources",
    evidenceStrength: "Medium",
    startedAt: "2026-08-23T08:00:00.000Z",
  },
  recording: { state: "recording" },
  currentHealth: { state: "normal" },
  productionQualification: { state: "qualified", ready: true },
  affectedTargets: [{ id: "gnss-l1", label: "GNSS L1" }],
  observation: { at: "2026-08-23T08:00:00.000Z", coverage: "observed" },
});

function frame(index: number): SpectrumFrame {
  return {
    id: `sweep-${index}`,
    timestamp: new Date(index * 1_000).toISOString(),
    receiver: 0,
    bandId: "survey-startrack",
    startHz: 410_000_000,
    endHz: 470_000_000,
    bins: new Uint8Array([index % 256]),
    source: "simulation",
    calibrated: false,
  };
}

const normalOperatorSummary = resolveOperatorSummary({
  generatedAt: "2026-08-23T08:00:00.000Z",
  serverBuildId: "release-a",
  dataDomain: "field",
  monitoring: {
    receiverOnline: true,
    dataFresh: true,
    paused: false,
    alertActive: false,
    recovering: false,
    candidateActive: false,
    detectingActive: false,
    checking: false,
  },
  recording: { state: "recording" },
  currentHealth: { state: "normal" },
  productionQualification: { state: "qualified", ready: true },
  observation: { at: "2026-08-23T08:00:00.000Z", coverage: "observed", targetId: "gnss-l1" },
});

function controlSnapshot(summary = normalOperatorSummary, serviceBootId = "boot-a"): MonitorSnapshot {
  return {
    generatedAt: summary.generatedAt,
    identity: {
      serviceBootId,
      release: { clientBuildId: "release-a", serverBuildId: "release-a" },
    },
    operatorSummary: summary,
    configuration: { configurationHash: "config-a" },
    bands: [],
    services: [],
    monitorGroups: [],
    monitorFeeds: [],
    waterfall: [],
  } as unknown as MonitorSnapshot;
}

describe("monotonic canonical live control", () => {
  it("applies a snapshot and newer alert delta through one ordered reducer", () => {
    const snapshotMessage = {
      type: "snapshot" as const,
      controlSequence: 10,
      payload: controlSnapshot(),
    };
    const alertMessage = {
      type: "state-delta" as const,
      controlSequence: 11,
      payload: {
        identity: controlSnapshot().identity,
        operatorSummary,
      },
    };
    const initial = controlSnapshot();
    const first = acceptCanonicalControlMessage(undefined, snapshotMessage, "release-a");
    expect(first).toMatchObject({ accepted: true, cursor: { serviceBootId: "boot-a", sequence: 10 } });
    if (!first.accepted) throw new Error("bootstrap was rejected");
    const second = acceptCanonicalControlMessage(first.cursor, alertMessage, "release-a");
    expect(second).toMatchObject({ accepted: true, cursor: { serviceBootId: "boot-a", sequence: 11 } });
    if (!second.accepted) throw new Error("delta was rejected");

    const afterSnapshot = applyAcceptedCanonicalControl(initial, first.message).snapshot;
    const afterAlert = applyAcceptedCanonicalControl(afterSnapshot, second.message).snapshot;
    expect(afterAlert.operatorSummary).toMatchObject({
      monitoring: { state: "alert" },
      incident: { id: "incident-kept" },
    });
  });

  it("rejects an older whole snapshot after a newer alert instead of merging either payload", () => {
    const cursor = { serviceBootId: "boot-a", sequence: 11 };
    const stale = acceptCanonicalControlMessage(cursor, {
      type: "snapshot",
      controlSequence: 10,
      payload: controlSnapshot(normalOperatorSummary),
    }, "release-a");
    expect(stale).toEqual({ accepted: false, stale: true });
  });

  it.each([
    {
      name: "a delta before bootstrap",
      cursor: undefined,
      message: { type: "state-delta", controlSequence: 1, payload: { identity: controlSnapshot().identity, operatorSummary } },
      issue: "invalid-control-sequence",
    },
    {
      name: "a missing sequence",
      cursor: undefined,
      message: { type: "snapshot", payload: controlSnapshot() },
      issue: "invalid-control-sequence",
    },
    {
      name: "a different service boot on one socket",
      cursor: { serviceBootId: "boot-a", sequence: 10 },
      message: { type: "snapshot", controlSequence: 11, payload: controlSnapshot(normalOperatorSummary, "boot-b") },
      issue: "control-epoch-changed",
    },
    {
      name: "a partial snapshot",
      cursor: undefined,
      message: {
        type: "snapshot",
        controlSequence: 1,
        payload: {
          identity: controlSnapshot().identity,
          operatorSummary: normalOperatorSummary,
        },
      },
      issue: "invalid-control-sequence",
    },
  ])("fails closed for $name", ({ cursor, message, issue }) => {
    expect(acceptCanonicalControlMessage(cursor, message, "release-a")).toEqual({
      accepted: false,
      stale: false,
      issue,
    });
  });
});

describe("bounded client waterfall history", () => {
  it("retains only the newest 32 completed sweep rows", () => {
    let history: SpectrumFrame[] = [];
    for (let index = 0; index < 100; index += 1) history = appendWaterfallFrame(history, frame(index));

    expect(history).toHaveLength(MAX_CLIENT_WATERFALL_ROWS);
    expect(history[0].id).toBe("sweep-68");
    expect(history.at(-1)?.id).toBe("sweep-99");
  });

  it("releases hidden-tab graph history after a bounded five minutes", () => {
    expect(HIDDEN_HISTORY_RELEASE_MS).toBe(5 * 60_000);
  });

  it("does not duplicate the current sweep after a reconnect replay", () => {
    const current = frame(5);
    const history = appendWaterfallFrame(appendWaterfallFrame([], current), current);
    expect(history).toEqual([current]);
  });
});

describe("browser live-data freshness", () => {
  afterEach(() => vi.useRealTimers());

  it("becomes data-late within five seconds despite continuous heartbeat, pong, and spectrum traffic", () => {
    vi.useFakeTimers();
    let current = {
      operatorSummary,
      operatorStatus: "Alert",
      monitoringReady: true,
      activeEvent: { id: "incident-kept" },
      receivers: [{ id: 0, url: "", connection: "live", lastFrameAt: "2026-08-23T08:00:00.000Z" }],
    } as unknown as MonitorSnapshot;
    const onLate = vi.fn(() => {
      current = snapshotWithClientDataLate(current, Date.parse("2026-08-23T08:00:05.000Z"));
    });
    const watchdog = new CanonicalStateFreshnessWatchdog(onLate);
    watchdog.start();

    const nonAuthoritativeTraffic = ["heartbeat", "pong", "spectrum"] as const;
    for (let index = 0; index < 9; index += 1) {
      vi.advanceTimersByTime(500);
      watchdog.observe(nonAuthoritativeTraffic[index % nonAuthoritativeTraffic.length]);
    }
    vi.advanceTimersByTime(499);
    watchdog.observe("heartbeat");
    expect(onLate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(current.operatorSummary).toMatchObject({
      monitoring: { state: "data-late", actionCode: "reload-live-data" },
      incident: { id: "incident-kept" },
    });
    expect(current.activeEvent?.id).toBe("incident-kept");
  });

  it.each(["snapshot", "state-delta"] as const)("only %s refreshes canonical freshness", (input) => {
    vi.useFakeTimers();
    const onLate = vi.fn();
    const watchdog = new CanonicalStateFreshnessWatchdog(onLate);
    watchdog.start();
    vi.advanceTimersByTime(4_000);
    watchdog.observe("heartbeat");
    watchdog.observe("spectrum");
    watchdog.observe(input);
    vi.advanceTimersByTime(4_999);
    expect(onLate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it("fails closed without deleting the last incident", () => {
    const startedAt = "2026-08-23T08:00:00.000Z";
    const snapshot = {
      operatorSummary,
      operatorStatus: "Normal",
      monitoringReady: true,
      receivers: [{
        id: 0,
        url: "ws://127.0.0.1:5454",
        connection: "live",
        transportState: "connected",
        streamState: "live",
        streamReady: true,
        lastFrameAt: startedAt,
      }],
      activeEvent: { id: "incident-kept" },
    } as unknown as MonitorSnapshot;

    const stale = snapshotWithClientDataLate(snapshot, Date.parse(startedAt) + 5_000);

    expect(stale.operatorStatus).toBe("Checking");
    expect(stale.monitoringReady).toBe(false);
    expect(stale.monitoringIssue).toBe("Live data is late.");
    expect(stale.activeEvent).toBe(snapshot.activeEvent);
    expect(stale.operatorSummary).toMatchObject({
      monitoring: { state: "data-late", reasonCode: "live-data-late", actionCode: "reload-live-data" },
      incident: { id: "incident-kept" },
    });
    expect(stale.receivers[0]).toMatchObject({
      connection: "stale",
      transportState: "reconnecting",
      streamState: "stalled",
      streamReady: false,
      lastFrameAgeMs: 5_000,
    });
  });

  it.each([
    {
      name: "a mismatched release",
      mutate: (summary: typeof operatorSummary) => summary,
      release: { clientBuildId: "release-b", serverBuildId: "release-b" },
      issue: "build-mismatch",
      monitoringIssue: "Software updated. Reload this page.",
    },
    {
      name: "an unknown monitoring state",
      mutate: (summary: typeof operatorSummary) => ({
        ...summary,
        monitoring: { ...summary.monitoring, state: "nominal" },
      }),
      release: { clientBuildId: "release-a", serverBuildId: "release-a" },
      issue: "invalid-operator-summary",
      monitoringIssue: "Live status is invalid. Reload this page.",
    },
    {
      name: "a malformed known qualification state",
      mutate: (summary: typeof operatorSummary) => ({
        ...summary,
        productionQualification: {
          ...summary.productionQualification,
          state: "pending",
          ready: true,
        },
      }),
      release: { clientBuildId: "release-a", serverBuildId: "release-a" },
      issue: "invalid-operator-summary",
      monitoringIssue: "Live status is invalid. Reload this page.",
    },
  ])("rejects $name without refreshing canonical freshness", ({ mutate, release, issue, monitoringIssue }) => {
    vi.useFakeTimers();
    const current = {
      operatorSummary,
      operatorStatus: "Alert",
      monitoringReady: true,
      monitoringIssue: undefined,
      activeEvent: { id: "incident-kept" },
      identity: { release: { clientBuildId: "release-a", serverBuildId: "release-a" } },
      receivers: [],
      waterfall: [],
    } as unknown as MonitorSnapshot;
    const delta = {
      identity: { release },
      operatorSummary: mutate(operatorSummary),
    };
    const onLate = vi.fn();
    const watchdog = new CanonicalStateFreshnessWatchdog(onLate);
    watchdog.start();
    vi.advanceTimersByTime(4_000);

    const result = applyCanonicalStateDelta(current, delta, "release-a", Date.parse("2026-08-23T08:00:04.000Z"));
    if (result.accepted) watchdog.observe("state-delta");
    expect(result).toMatchObject({ accepted: false, issue });
    expect(result.snapshot).toMatchObject({
      operatorSummary: {
        monitoring: { state: "data-late", actionCode: "reload-page" },
        incident: { id: "incident-kept" },
        productionQualification: { state: "pending", ready: false },
      },
      activeEvent: { id: "incident-kept" },
      monitoringReady: false,
      monitoringIssue,
    });

    vi.advanceTimersByTime(1_000);
    expect(onLate).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });
});

describe("browser release identity", () => {
  const identitySnapshot = {
    operatorSummary,
    identity: { release: { clientBuildId: "release-a", serverBuildId: "release-a" } },
    operatorStatus: "Normal",
    monitoringReady: true,
  } as unknown as MonitorSnapshot;

  it("allows development HTML without embedded release metadata", () => {
    expect(clientBuildMatches(identitySnapshot, undefined)).toBe(true);
  });

  it("requires the embedded client and server package to match", () => {
    expect(clientBuildMatches(identitySnapshot, "release-a")).toBe(true);
    expect(clientBuildMatches(identitySnapshot, "release-b")).toBe(false);
    expect(clientBuildMatches({
      ...identitySnapshot,
      identity: { ...identitySnapshot.identity, release: { ...identitySnapshot.identity.release, serverBuildId: "server-b" } },
    }, "release-a")).toBe(false);
  });

  it("fails closed with a direct reload action", () => {
    expect(snapshotWithBuildMismatch(identitySnapshot)).toMatchObject({
      operatorSummary: {
        monitoring: { state: "data-late", actionCode: "reload-page" },
        incident: { id: "incident-kept" },
        currentHealth: { state: "attention" },
        productionQualification: { state: "pending", ready: false },
      },
      operatorStatus: "Checking",
      monitoringReady: false,
      monitoringIssue: "Software updated. Reload this page.",
    });
  });

  it("never labels an uninitialized or invalid live contract as Simulation", () => {
    const unknownSummary = resolveOperatorSummary({
      generatedAt: "2026-08-23T08:00:00.000Z",
      serverBuildId: "loading",
      dataDomain: "unknown",
      monitoring: {
        receiverOnline: false,
        dataFresh: false,
        paused: false,
        alertActive: false,
        recovering: false,
        candidateActive: false,
        detectingActive: false,
        checking: true,
      },
      recording: { state: "stopped" },
      currentHealth: { state: "attention" },
      productionQualification: { state: "failed", ready: false },
      observation: { at: null, coverage: "unknown" },
    });
    expect(snapshotWithInvalidOperatorState({ ...identitySnapshot, operatorSummary: unknownSummary })).toMatchObject({
      operatorSummary: {
        dataMode: "unknown",
        monitoring: { state: "data-late", actionCode: "reload-page" },
        productionQualification: { state: "pending", ready: false },
      },
      monitoringIssue: "Live status is invalid. Reload this page.",
    });
  });
});

describe("baseline restart response", () => {
  const complete = {
    configurationRevision: 4,
    operation: {
      operationId: "restart-1",
      committed: true as const,
      state: "complete" as const,
      auditDurable: true,
    },
  };

  it("accepts only an audited complete operation as normal success", () => {
    expect(baselineRestartRequiresRecovery(complete)).toBe(false);
    expect(baselineRestartRequiresRecovery({
      ...complete,
      operation: { ...complete.operation, state: "recovery-required" },
    })).toBe(true);
    expect(baselineRestartRequiresRecovery({
      ...complete,
      operation: { ...complete.operation, auditDurable: false },
    })).toBe(true);
    expect(baselineRestartRequiresRecovery({ configurationRevision: 4 })).toBe(true);
  });
});

describe("LiveConnectionGenerations", () => {
  it("treats only the newest lifecycle as current", () => {
    const generations = new LiveConnectionGenerations();
    const first = generations.begin();
    const second = generations.begin();
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
  });

  it("rejects a callback from a run that was superseded before it settled", () => {
    // Reproduces StrictMode's mount -> cleanup -> mount order: mount #1 begins, cleanup #1
    // supersedes it before its bootstrap request resolves, mount #2 begins. The late
    // callback from mount #1 must not be mistaken for the run that owns the socket.
    const generations = new LiveConnectionGenerations();
    const first = generations.begin();
    generations.supersede();
    const second = generations.begin();
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
  });

  it("invalidates the current lifecycle when superseded with no replacement", () => {
    const generations = new LiveConnectionGenerations();
    const only = generations.begin();
    generations.supersede();
    expect(generations.isCurrent(only)).toBe(false);
    // supersede() alone already consumed generation only+1 as an internal placeholder, so the
    // next lifecycle a real begin() call would create is only+2 — confirm it isn't current
    // either, i.e. no generation is valid until begin() actually mints it.
    expect(generations.isCurrent(only + 2)).toBe(false);
  });

  it("keeps generations distinct across many cycles", () => {
    const generations = new LiveConnectionGenerations();
    const seen: number[] = [];
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const generation = generations.begin();
      seen.forEach((earlier) => expect(generations.isCurrent(earlier)).toBe(false));
      expect(generations.isCurrent(generation)).toBe(true);
      seen.push(generation);
      generations.supersede();
    }
  });
});
