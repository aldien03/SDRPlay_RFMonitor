import { describe, expect, it } from "vitest";
import type { OperatorMonitoringState } from "../src/shared/operatorSummary";
import { LatestLiveControlQueue } from "../src/server/liveControlQueue";

describe("bounded live control delivery", () => {
  it.each(["offline", "data-late", "alert"] satisfies OperatorMonitoringState[])(
    "delivers a queued %s transition as soon as pressure clears",
    (monitoringState) => {
      const queue = new LatestLiveControlQueue(1_024, 2_000, 10_000);
      queue.markDeliveredState("normal");
      expect(queue.enqueue(`state:${monitoringState}`, monitoringState, 1_000)).toEqual({ state: "queued" });
      expect(queue.drain(1_000, () => false)).toEqual({ state: "retry" });
      expect(queue.drain(2_999, () => false)).toEqual({ state: "retry" });
      const delivered: string[] = [];
      expect(queue.drain(3_000, (payload) => { delivered.push(payload); return true; })).toEqual({ state: "delivered" });
      expect(delivered).toEqual([`state:${monitoringState}`]);
      expect(queue.hasPending).toBe(false);
    },
  );

  it.each(["offline", "data-late", "alert"] satisfies OperatorMonitoringState[])(
    "fails closed when a %s transition cannot be delivered by its deadline",
    (monitoringState) => {
      const queue = new LatestLiveControlQueue(1_024, 2_000, 10_000);
      queue.markDeliveredState("normal");
      queue.enqueue(`state:${monitoringState}`, monitoringState, 1_000);
      expect(queue.drain(3_000, () => false)).toEqual({
        state: "close",
        reason: "Safety state could not be delivered",
      });
    },
  );

  it("closes instead of overwriting an undelivered safety transition", () => {
    const queue = new LatestLiveControlQueue(1_024);
    queue.markDeliveredState("normal");
    queue.enqueue("state:alert", "alert", 1_000);
    expect(queue.drain(1_000, () => false)).toEqual({ state: "retry" });
    expect(queue.enqueue("state:recovering", "recovering", 1_100)).toEqual({
      state: "close",
      reason: "Safety state changed before delivery",
    });
  });

  it("coalesces 100,000 routine deltas into one bounded latest value", () => {
    const queue = new LatestLiveControlQueue(1_024);
    queue.markDeliveredState("checking");
    for (let index = 0; index < 100_000; index += 1) {
      expect(queue.enqueue(`checking:${index}`, "checking", index).state).toBe("queued");
    }
    expect(queue.pendingBytes).toBeLessThan(1_024);
    const delivered: string[] = [];
    expect(queue.drain(100_000, (payload) => { delivered.push(payload); return true; })).toEqual({ state: "delivered" });
    expect(delivered).toEqual(["checking:99999"]);
  });

  it("rejects an oversized control value instead of allocating another slot", () => {
    const queue = new LatestLiveControlQueue(16);
    expect(queue.enqueue("x".repeat(17), "alert", 0)).toEqual({
      state: "close",
      reason: "Control state exceeded its resource bound",
    });
    expect(queue.pendingBytes).toBe(0);
  });

  it("preserves bins-free incident, recording, and qualification truth in critical status-only delivery", () => {
    const queue = new LatestLiveControlQueue(128 * 1024);
    queue.markDeliveredState("normal");
    const control = JSON.stringify({
      type: "state-delta",
      payload: {
        dashboardsStatusOnly: true,
        operatorSummary: {
          monitoring: { state: "alert", reasonCode: "rf-anomaly-active" },
          incident: { state: "active", reasonCode: "suspected-rf-interference", affectedTargetIds: ["gnss-l1"] },
          recording: { state: "recording", reasonCode: "recording-active" },
          productionQualification: { state: "pending", ready: false, reasonCodes: ["baseline-pending"] },
        },
        activeEvent: { id: "incident-1", lifecycle: "active", affectedBandIds: ["gps-l1"] },
      },
    });
    expect(control).not.toContain('"bins"');
    expect(queue.enqueue(control, "alert", 0)).toEqual({ state: "queued" });
    let delivered = "";
    expect(queue.drain(1, (payload) => { delivered = payload; return true; })).toEqual({ state: "delivered" });
    expect(JSON.parse(delivered)).toMatchObject({
      payload: {
        dashboardsStatusOnly: true,
        operatorSummary: {
          monitoring: { state: "alert" },
          incident: { state: "active" },
          recording: { state: "recording" },
          productionQualification: { ready: false },
        },
        activeEvent: { id: "incident-1", lifecycle: "active" },
      },
    });
  });
});
