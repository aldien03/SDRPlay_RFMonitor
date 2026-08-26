import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, withOperationalSettings } from "../src/server/config";
import { MonitorService } from "../src/server/monitorService";
import { applyMonitoringMission } from "../src/shared/settings";
import type { DetectionEvent, PersistedSpectrumFrame, ServiceMessage } from "../src/shared/types";

vi.mock("../src/server/usbPresence", () => ({ detectSdrplayUsb: vi.fn().mockResolvedValue("present") }));

const roots: string[] = [];
const monitors = new Set<MonitorService>();

afterEach(async () => {
  // Stop every service while the fake monotonic clock that created its
  // schedulers is still installed. This also protects later tests when an
  // assertion aborts before their explicit cleanup.
  await Promise.all([...monitors].map((monitor) => monitor.stop().catch(() => undefined)));
  monitors.clear();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(exercises = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-live-exercise-"));
  roots.push(root);
  const base = await loadConfig({
    RF_MONITOR_STORAGE: root,
    RF_MONITOR_SIMULATION: "on",
    RF_MONITOR_SYNTHETIC_EXERCISES: exercises ? "true" : "false",
  });
  // These tests exercise every Tier-1 target. New installations intentionally
  // default to one-target Primary Watch, so opt this fixture into Multi-band.
  const value = withOperationalSettings(
    base,
    applyMonitoringMission(base.operationalSettings, base.bandCatalog, "multi-band-survey"),
  );
  value.settingsPaths.operational = path.join(root, "operational.json");
  value.settingsPaths.audit = path.join(root, "audit.jsonl");
  value.settingsPaths.revisions = path.join(root, "revisions");
  return value;
}

async function createMonitor(exercises = true): Promise<MonitorService> {
  const monitor = new MonitorService(await config(exercises));
  monitors.add(monitor);
  return monitor;
}

async function stopMonitor(monitor: MonitorService): Promise<void> {
  await monitor.stop();
  monitors.delete(monitor);
}

describe("live synthetic exercise", () => {
  it("drives the main L1 graph through alert and ten-clean recovery with isolated test evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T07:00:00.000Z"));
    const monitor = await createMonitor();
    await monitor.start();
    await vi.advanceTimersByTimeAsync(1_200);

    const internal = monitor as unknown as {
      evidence: {
        recordFrame(frame: PersistedSpectrumFrame, summary: object): Promise<void>;
        recordEvent(event: DetectionEvent, destinationSessionId?: string, baselineReference?: object): Promise<void>;
      };
    };
    const recordFrame = vi.spyOn(internal.evidence, "recordFrame");
    const recordEvent = vi.spyOn(internal.evidence, "recordEvent");
    const baselineBefore = monitor.getBaselineStates().filter((item) => item.targetId === "gnss-l1-e1-b1c-sbas");
    const phases = new Set<string>();
    const frames: PersistedSpectrumFrame[] = [];
    monitor.on("message", (message: ServiceMessage) => {
      if (message.type === "snapshot" && message.payload.syntheticExercise) phases.add(message.payload.syntheticExercise.phase);
      if (message.type === "frame" && message.payload.frame.syntheticExercise) frames.push(message.payload.frame as PersistedSpectrumFrame);
    });

    const started = monitor.startSyntheticExercise("wideband");
    expect(started).toMatchObject({ synthetic: true, phase: "waiting-for-target", scenarioId: "wideband" });
    await vi.advanceTimersByTimeAsync(50_000);

    const snapshot = monitor.getSnapshot();
    expect(snapshot.syntheticExercise).toMatchObject({
      synthetic: true,
      scenarioId: "wideband",
      phase: "complete",
      observedOutcome: "alert",
      verdict: "Suspected RF interference",
      cleanChecks: 10,
    });
    expect(frames.length).toBeGreaterThan(20);
    expect(frames.some((frame) => Math.max(...frame.bins) > 90)).toBe(true);
    expect(frames.every((frame) => frame.syntheticExercise?.runId === started.runId)).toBe(true);
    expect(snapshot.events[0]).toMatchObject({
      sessionId: `synthetic:${started.runId}`,
      lifecycle: "cleared",
      syntheticExercise: { runId: started.runId, scenarioId: "wideband" },
    });
    expect(phases).toEqual(expect.objectContaining(new Set(["running", "alert", "recovering", "complete"])));
    expect(snapshot.waterfall.length).toBeLessThanOrEqual(32);
    const storedSyntheticFrames = recordFrame.mock.calls.map(([frame]) => frame).filter((frame) => frame.syntheticExercise?.runId === started.runId);
    expect(storedSyntheticFrames.length).toBeGreaterThan(0);
    expect(storedSyntheticFrames.every((frame) => frame.dataDomain === "test" && frame.source === "simulation")).toBe(true);
    const storedSyntheticEvents = recordEvent.mock.calls.map(([event]) => event).filter((event) => event.syntheticExercise?.runId === started.runId);
    expect(storedSyntheticEvents.some((event) => event.lifecycle === "active")).toBe(true);
    expect(storedSyntheticEvents.some((event) => event.lifecycle === "cleared")).toBe(true);
    expect(storedSyntheticEvents.every((event) => event.dataDomain === "test"
      && !event.sessionId.startsWith("synthetic:")
      && event.sessionIds?.every((sessionId) => !sessionId.startsWith("synthetic:")))).toBe(true);
    expect(monitor.getBaselineStates().filter((item) => item.targetId === "gnss-l1-e1-b1c-sbas")).toEqual(baselineBefore);

    expect(monitor.stopSyntheticExercise()).toBeUndefined();
    const restored = monitor.getSnapshot();
    expect(restored.syntheticExercise).toBeUndefined();
    expect(restored.events.some((event) => event.syntheticExercise?.runId === started.runId)).toBe(false);
    expect(restored.currentFrame?.syntheticExercise).toBeUndefined();
    await stopMonitor(monitor);
  }, 20_000);

  it("keeps the matched-power control clear and reports spectrum non-detection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T08:00:00.000Z"));
    const monitor = await createMonitor();
    await monitor.start();
    monitor.startSyntheticExercise("matched-power-spoofing");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.getSnapshot().syntheticExercise).toMatchObject({
      phase: "complete",
      observedOutcome: "no-alert",
      verdict: "No RF change detected",
    });
    expect(monitor.getSnapshot().events.some((event) => event.syntheticExercise)).toBe(false);
    await stopMonitor(monitor);
  }, 20_000);

  it.each([
    ["gnss-gps-l2c", 1_227_600_000],
    ["gnss-l5-e5a-b2a", 1_176_450_000],
    ["gnss-glonass-g1", 1_601_719_000],
  ] as const)("drives %s through the real Tier-1 scheduler and recovery path", async (targetId, centerHz) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T08:30:00.000Z"));
    const monitor = await createMonitor();
    await monitor.start();
    let completed: ReturnType<MonitorService["getSyntheticExercise"]>;
    const exerciseFrames: PersistedSpectrumFrame[] = [];
    monitor.on("message", (message: ServiceMessage) => {
      if (message.type === "snapshot" && message.payload.syntheticExercise?.phase === "complete") {
        completed = message.payload.syntheticExercise;
      }
      if (message.type === "frame" && message.payload.frame.syntheticExercise) {
        exerciseFrames.push(message.payload.frame as PersistedSpectrumFrame);
      }
    });
    const started = monitor.startSyntheticExercise("wideband", targetId);
    expect(started).toMatchObject({ targetId, centerHz, phase: "waiting-for-target" });
    await vi.advanceTimersByTimeAsync(120_000);
    const snapshot = monitor.getSnapshot();
    expect(completed).toMatchObject({
      targetId,
      centerHz,
      phase: "complete",
      observedOutcome: "alert",
      verdict: "Suspected RF interference",
      cleanChecks: 10,
    });
    expect(exerciseFrames.length).toBeGreaterThan(10);
    expect(exerciseFrames.every((frame) => frame.targetId === targetId
      && frame.requestedCenterHz === centerHz
      && frame.confirmedCenterHz === centerHz
      && frame.syntheticExercise?.runId === started.runId)).toBe(true);
    const completedEvent = snapshot.events.find((event) => event.syntheticExercise?.runId === started.runId);
    if (completedEvent) expect(completedEvent).toMatchObject({
      targetId,
      sessionId: `synthetic:${started.runId}`,
      lifecycle: "cleared",
    });
    await stopMonitor(monitor);
  }, 60_000);

  it.each([
    ["overload", "alert", "Receiver overloaded"],
    ["data-gap", "unknown", "Test inconclusive"],
    ["configuration-change", "unknown", "Test inconclusive"],
  ] as const)("projects %s with the expected bounded outcome", async (scenarioId, observedOutcome, verdict) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T09:00:00.000Z"));
    const monitor = await createMonitor();
    await monitor.start();
    monitor.startSyntheticExercise(scenarioId);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(monitor.getSnapshot().syntheticExercise).toMatchObject({ phase: "complete", observedOutcome, verdict });
    if (observedOutcome === "unknown") expect(monitor.getSnapshot().events.some((event) => event.syntheticExercise)).toBe(false);
    await stopMonitor(monitor);
  }, 20_000);

  it("removes the injected condition on Stop and still requires clean recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    const monitor = await createMonitor();
    await monitor.start();
    monitor.startSyntheticExercise("wideband");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(monitor.getSnapshot().syntheticExercise?.phase).toBe("alert");
    expect(monitor.stopSyntheticExercise()).toMatchObject({ stopRequested: true });
    expect(monitor.getSnapshot().syntheticExercise?.phase).toBe("alert");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.getSnapshot().syntheticExercise).toMatchObject({ phase: "complete", cleanChecks: 10 });
    await stopMonitor(monitor);
  }, 20_000);

  it("requires both explicit simulation and the exercise opt-in", async () => {
    const monitor = await createMonitor(false);
    await expect(monitor.start()).resolves.toBeUndefined();
    expect(() => monitor.startSyntheticExercise("wideband")).toThrow(/not enabled/);
    await stopMonitor(monitor);
  });

  it("rejects optional and unknown targets at the playback boundary", async () => {
    const monitor = await createMonitor();
    await monitor.start();
    expect(() => monitor.startSyntheticExercise("wideband", "gnss-beidou-b1i")).toThrow(/Tier-1/);
    expect(() => monitor.startSyntheticExercise("wideband", "not-a-target")).toThrow(/Tier-1/);
    await stopMonitor(monitor);
  });
});
