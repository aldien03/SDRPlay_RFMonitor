import { describe, expect, it } from "vitest";
import {
  ConcurrentRequestGate,
  OutboundTrafficMeter,
  RESOURCE_LIMITS,
  ResourceBudgetController,
  RollingByteRate,
  TokenBucket,
  type ResourceBudgetSample,
} from "../src/server/resourceBudget";

const healthySample = (overrides: Partial<ResourceBudgetSample> = {}): ResourceBudgetSample => ({
  rssBytes: 128 * 1024 * 1024,
  heapUtilization: 0.25,
  externalBytes: 16 * 1024 * 1024,
  writerQueueItems: 0,
  writerQueueBytes: 0,
  writerOldestAgeMs: 0,
  eventLoopDelayP99Ms: 5,
  diskBelowReserve: false,
  ...overrides,
});

describe("bounded streaming resources", () => {
  it("enforces burst and sustained token limits", () => {
    const bucket = new TokenBucket(100, 200, 0);
    expect(bucket.take(200, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
    expect(bucket.take(100, 1_000)).toBe(true);
    expect(bucket.take(101, 1_000)).toBe(false);
  });

  it("reports bounded rolling rates", () => {
    const rate = new RollingByteRate();
    rate.add(100, 0);
    rate.add(300, 1_000);
    expect(rate.bytesPerSecond(10, 1_000)).toBe(40);
    expect(rate.bytesPerSecond(60, 61_000)).toBe(0);
  });

  it("reports live, HTTP, and aggregate application egress independently", () => {
    const meter = new OutboundTrafficMeter();
    meter.addLive(200, 0);
    meter.addHttp(300, 1_000);
    expect(meter.snapshot(1_000)).toMatchObject({
      liveBytes: 200,
      httpBytes: 300,
      applicationBytes: 500,
      liveBytesPerSecond10s: 20,
      httpBytesPerSecond10s: 30,
      applicationBytesPerSecond10s: 50,
    });
    expect(meter.snapshot(61_000).applicationBytesPerSecond60s).toBe(0);
  });

  it("caps concurrent work and makes release idempotent", () => {
    const gate = new ConcurrentRequestGate(2);
    const releaseFirst = gate.tryAcquire();
    const releaseSecond = gate.tryAcquire();
    expect(gate.active).toBe(2);
    expect(gate.tryAcquire()).toBeUndefined();
    expect(gate.rejected).toBe(1);
    releaseFirst?.();
    releaseFirst?.();
    expect(gate.active).toBe(1);
    const releaseThird = gate.tryAcquire();
    expect(releaseThird).toBeTypeOf("function");
    releaseSecond?.();
    releaseThird?.();
    expect(gate.active).toBe(0);
  });

  it("[trace:RES-012] [trace:RES-013] [trace:RES-014] [trace:RES-015] enters pressure and critical at the documented exact thresholds", () => {
    const controller = new ResourceBudgetController({}, 0);
    expect(controller.update(healthySample({ rssBytes: RESOURCE_LIMITS.pressureRssBytes - 1 }), 0).state).toBe("normal");
    expect(controller.update(healthySample({ rssBytes: RESOURCE_LIMITS.pressureRssBytes }), 1)).toMatchObject({
      state: "pressure",
      reasons: ["rss-pressure"],
      admitLiveClients: false,
      admitExports: false,
      maxDashboardRateHz: 0.2,
      dashboardsStatusOnly: true,
      preserveMonitoringPipeline: true,
    });
    expect(controller.update(healthySample({ rssBytes: RESOURCE_LIMITS.criticalRssBytes }), 2)).toMatchObject({
      state: "critical",
      reasons: ["rss-critical"],
      dashboardsStatusOnly: true,
      preserveMonitoringPipeline: true,
    });
    expect(new ResourceBudgetController({}, 0).update(healthySample({ heapUtilization: RESOURCE_LIMITS.pressureHeapUtilization }), 1))
      .toMatchObject({ state: "pressure", reasons: ["heap-pressure"] });
    expect(new ResourceBudgetController({}, 0).update(healthySample({ externalBytes: RESOURCE_LIMITS.pressureExternalBytes }), 1))
      .toMatchObject({ state: "pressure", reasons: ["external-buffer-pressure"] });
  });

  it("[trace:RES-016] does not delay critical writer latency or disk-reserve entry", () => {
    const writer = new ResourceBudgetController({}, 0);
    expect(writer.update(healthySample({ writerOldestAgeMs: RESOURCE_LIMITS.criticalWriterOldestAgeMs }), 1)).toMatchObject({
      state: "critical",
      reasons: ["writer-latency-critical"],
    });
    const disk = new ResourceBudgetController({}, 0);
    expect(disk.update(healthySample({ diskBelowReserve: true }), 1)).toMatchObject({
      state: "critical",
      reasons: ["disk-reserve-critical"],
    });
    expect(disk.update(healthySample({ rssBytes: RESOURCE_LIMITS.pressureRssBytes }), 10_000).state).toBe("critical");
    expect(disk.update(healthySample(), 20_000)).toMatchObject({ state: "critical", healthySince: 20_000 });
    expect(disk.update(healthySample(), 49_999).state).toBe("critical");
    expect(disk.update(healthySample(), 50_000).state).toBe("normal");
  });

  it("requires sustained queue/event-loop pressure and a continuous healthy recovery dwell", () => {
    const controller = new ResourceBudgetController({ pressureSustainMs: 10_000, healthyRecoveryDwellMs: 30_000 }, 0);
    const queue = healthySample({ writerQueueItems: RESOURCE_LIMITS.pressureWriterQueueItems });
    expect(controller.update(queue, 1_000).state).toBe("normal");
    expect(controller.update(queue, 10_999).state).toBe("normal");
    expect(controller.update(queue, 11_000)).toMatchObject({ state: "pressure", reasons: ["writer-queue-pressure"] });

    expect(controller.update(healthySample(), 20_000)).toMatchObject({ state: "pressure", healthySince: 20_000 });
    expect(controller.update(healthySample({ heapUtilization: RESOURCE_LIMITS.pressureHeapUtilization }), 35_000).state).toBe("pressure");
    expect(controller.update(healthySample(), 36_000)).toMatchObject({ state: "pressure", healthySince: 36_000 });
    expect(controller.update(healthySample(), 65_999).state).toBe("pressure");
    expect(controller.update(healthySample(), 66_000).state).toBe("normal");

    const eventLoop = healthySample({ eventLoopDelayP99Ms: RESOURCE_LIMITS.pressureEventLoopP99Ms });
    expect(controller.update(eventLoop, 70_000).state).toBe("normal");
    expect(controller.update(eventLoop, 80_000)).toMatchObject({ state: "pressure", reasons: ["event-loop-pressure"] });
  });

  it("keeps status-only incident/control delivery separate from spectrum admission", () => {
    const controller = new ResourceBudgetController({}, 0);
    const policy = controller.update(healthySample({ rssBytes: RESOURCE_LIMITS.criticalRssBytes }), 1);
    expect(policy).toMatchObject({
      dashboardsStatusOnly: true,
      admitLiveClients: false,
      admitExports: false,
      preserveMonitoringPipeline: true,
    });
  });
});
