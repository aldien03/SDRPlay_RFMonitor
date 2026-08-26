import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_SCREENSHOT_PNG_BYTES,
  ScreenshotAdmissionController,
  ScreenshotBodyGate,
  ScreenshotPngError,
  scanPersistedScreenshotUsage,
  validateScreenshotPng,
} from "../src/server/screenshotAdmission";
import { loadConfig } from "../src/server/config";
import { MonitorService } from "../src/server/monitorService";
import { EvidenceStore } from "../src/server/evidenceStore";
import type { DetectionEvent, ResourceHealth } from "../src/shared/types";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("screenshot admission", () => {
  it("allows only two concurrent route bodies and releases slots idempotently", () => {
    const gate = new ScreenshotBodyGate();
    const validFirst = gate.tryAcquire();
    const validSecond = gate.tryAcquire();
    expect(validFirst).toBeTypeOf("function");
    expect(validSecond).toBeTypeOf("function");
    expect(gate.active).toBe(2);
    expect(gate.tryAcquire()).toBeUndefined();
    validFirst?.();
    validFirst?.();
    expect(gate.active).toBe(1);
    const unknownUpload = gate.tryAcquire();
    expect(unknownUpload).toBeTypeOf("function");
    validSecond?.();
    unknownUpload?.();
    expect(gate.active).toBe(0);
  });

  it("accepts a bounded PNG and rejects oversized dimensions, truncated chunks, and excess bytes", () => {
    expect(validateScreenshotPng(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });

    const oversizedDimensions = Buffer.from(ONE_PIXEL_PNG);
    oversizedDimensions.writeUInt32BE(8_193, 16);
    expect(() => validateScreenshotPng(oversizedDimensions)).toThrow(ScreenshotPngError);
    expect(() => validateScreenshotPng(ONE_PIXEL_PNG.subarray(0, -1))).toThrow(/chunk|IEND|required/);
    expect(() => validateScreenshotPng(Buffer.alloc(MAX_SCREENSHOT_PNG_BYTES + 1))).toThrow(/must contain/);
  });

  it("counts concurrent pre-body reservations and enforces event/global count and byte quotas", () => {
    const controller = new ScreenshotAdmissionController({
      perEventCount: 2,
      perEventBytes: 100,
      globalCount: 3,
      globalBytes: 140,
      perEventRate: 10,
      globalRate: 10,
    });
    const first = controller.reserve("event-a", 50);
    const second = controller.reserve("event-a", 50);
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(controller.reserve("event-a", 1)).toMatchObject({ admitted: false, reason: "count" });
    expect(controller.reserve("event-b", 50)).toMatchObject({ admitted: false, reason: "bytes" });
    if (!first.admitted || !second.admitted) throw new Error("Expected concurrent reservations");
    first.lease.release();
    second.lease.commit(40);
    const third = controller.reserve("event-b", 50);
    expect(third.admitted).toBe(true);
    if (third.admitted) third.lease.commit(50);
    expect(controller.reserve("event-c", 51)).toMatchObject({ admitted: false, reason: "bytes" });
  });

  it("bounds rate history and expires old per-event admission state", () => {
    let now = 1_000;
    const controller = new ScreenshotAdmissionController({
      now: () => now,
      perEventCount: 10,
      perEventBytes: 1_000,
      globalCount: 10,
      globalBytes: 1_000,
      rateWindowMs: 100,
      perEventRate: 2,
      globalRate: 3,
      globalWindowMs: 200,
    });
    for (const eventId of ["event-a", "event-a"]) {
      const result = controller.reserve(eventId, 10);
      if (!result.admitted) throw new Error("Expected admission");
      result.lease.release();
    }
    expect(controller.reserve("event-a", 10)).toMatchObject({ admitted: false, reason: "rate" });
    expect(controller.trackedEventCount).toBe(1);
    now += 201;
    const afterExpiry = controller.reserve("event-b", 10);
    expect(afterExpiry.admitted).toBe(true);
    expect(controller.trackedEventCount).toBe(1);
    if (afterExpiry.admitted) afterExpiry.lease.release();
  });

  it("rejects a known event before body admission while monitoring resources are under pressure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-screenshot-pressure-"));
    try {
      const config = await loadConfig({ RF_MONITOR_STORAGE: root, RF_MONITOR_SIMULATION: "on" });
      const monitor = new MonitorService(config);
      const event = { id: "event-pressure", syntheticExercise: undefined } as unknown as DetectionEvent;
      (monitor as unknown as { events: DetectionEvent[] }).events.push(event);
      monitor.noteResourceHealth({ state: "pressure", dashboardsStatusOnly: true } as ResourceHealth);
      expect(monitor.reserveScreenshot(event.id, 100)).toMatchObject({
        admitted: false,
        reason: "pressure",
        retryAfterSeconds: 10,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconstructs screenshot quotas from bounded legacy and event-directory evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-screenshot-scan-"));
    try {
      const screenshotRoot = path.join(root, "session-one", "screenshots");
      await mkdir(path.join(screenshotRoot, "event-new"), { recursive: true });
      await writeFile(path.join(screenshotRoot, "event-new", "2026-08-23T12-00-00-000Z-a1b2c3d4.png"), ONE_PIXEL_PNG);
      await writeFile(path.join(screenshotRoot, "2026-08-23T12-00-01-000Z-event-legacy.png"), ONE_PIXEL_PNG);

      const usage = await scanPersistedScreenshotUsage(root, { globalCount: 10, globalBytes: 10_000 });
      expect(usage).toMatchObject({ complete: true, saturated: false, scannedSessions: 1, scannedEntries: 4 });
      expect(usage.records).toEqual(expect.arrayContaining([
        { eventId: "event-new", bytes: ONE_PIXEL_PNG.byteLength },
        { eventId: "event-legacy", bytes: ONE_PIXEL_PNG.byteLength },
      ]));

      const bounded = await scanPersistedScreenshotUsage(root, {
        maxEntries: 1,
        globalCount: 10,
        globalBytes: 10_000,
      });
      expect(bounded).toMatchObject({ complete: false, saturated: false, failure: "screenshot scan entry bound reached" });
      expect(bounded.records.length).toBeLessThan(2);

      await mkdir(path.join(screenshotRoot, "event-new", "nested"));
      const nested = await scanPersistedScreenshotUsage(root, { globalCount: 10, globalBytes: 10_000 });
      expect(nested).toMatchObject({
        complete: false,
        saturated: false,
        failure: "nested or linked screenshot evidence is not allowed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps per-event and global screenshot quotas charged across a crash-style reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-screenshot-restart-"));
    const options = {
      dataDomain: "field" as const,
      screenshotAdmission: {
        perEventCount: 2,
        perEventBytes: 1_000,
        globalCount: 3,
        globalBytes: 2_000,
        perEventRate: 20,
        globalRate: 20,
      },
    };
    try {
      const beforeCrash = new EvidenceStore(root, options);
      const firstSession = await beforeCrash.initialize({ config: {}, sdrconnect: {} });
      await beforeCrash.recordScreenshot(firstSession.id, "event-a", ONE_PIXEL_PNG);
      await beforeCrash.recordScreenshot(firstSession.id, "event-a", ONE_PIXEL_PNG);
      expect(beforeCrash.getScreenshotQuotaHealth()).toMatchObject({ ready: true, count: 2, bytes: ONE_PIXEL_PNG.byteLength * 2 });

      // A new store reconstructs quota directly from files left by the prior
      // process; no graceful close or in-memory handoff is involved.
      const afterCrash = new EvidenceStore(root, options);
      const secondSession = await afterCrash.initialize({ config: {}, sdrconnect: {} });
      expect(afterCrash.getScreenshotQuotaHealth()).toMatchObject({ ready: true, count: 2, bytes: ONE_PIXEL_PNG.byteLength * 2 });
      expect(afterCrash.reserveScreenshot("event-a", 1)).toMatchObject({ admitted: false, reason: "count" });
      await afterCrash.recordScreenshot(secondSession.id, "event-b", ONE_PIXEL_PNG);

      const afterSecondCrash = new EvidenceStore(root, options);
      await afterSecondCrash.initialize({ config: {}, sdrconnect: {} });
      expect(afterSecondCrash.getScreenshotQuotaHealth()).toMatchObject({ ready: true, count: 3 });
      expect(afterSecondCrash.reserveScreenshot("event-c", 1)).toMatchObject({ admitted: false, reason: "count" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on an incomplete disk scan without mixing field and test quota", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-screenshot-domain-"));
    try {
      const fieldRoot = path.join(parent, "field-evidence");
      const testRoot = path.join(parent, "test-evidence");
      const field = new EvidenceStore(fieldRoot, {
        dataDomain: "field",
        screenshotAdmission: { globalCount: 10, globalBytes: 10_000 },
      });
      const fieldSession = await field.initialize({ config: {}, sdrconnect: {} });
      await field.recordScreenshot(fieldSession.id, "field-event", ONE_PIXEL_PNG);
      await field.recordScreenshot(fieldSession.id, "field-event", ONE_PIXEL_PNG);

      const isolatedTest = new EvidenceStore(testRoot, {
        dataDomain: "test",
        screenshotAdmission: { globalCount: 10, globalBytes: 10_000 },
      });
      await isolatedTest.initialize({ config: {}, sdrconnect: {} });
      expect(isolatedTest.getScreenshotQuotaHealth()).toMatchObject({ ready: true, count: 0, bytes: 0 });

      const failClosed = new EvidenceStore(fieldRoot, {
        dataDomain: "field",
        screenshotAdmission: { globalCount: 10, globalBytes: 10_000 },
        screenshotScan: { maxEntries: 1, maxSessions: 1 },
      });
      await failClosed.initialize({ config: {}, sdrconnect: {} });
      expect(failClosed.getScreenshotQuotaHealth()).toMatchObject({ ready: false });
      expect(failClosed.reserveScreenshot("field-event", 1)).toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
