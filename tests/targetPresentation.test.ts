import { describe, expect, it } from "vitest";
import { authoritativeTargetStates, targetObservationAt } from "../src/client/targetPresentation";
import type { ChannelMonitorState } from "../src/shared/types";
import type { TargetFrameState } from "../src/client/useMonitor";

function state(targetId: string, lastObservedAt: string, lifecycle: ChannelMonitorState["lifecycle"]): ChannelMonitorState {
  return { targetId, lastObservedAt, lifecycle, candidateCount: 0, clearCount: 0, requiredCount: 10, observationDisposition: "clean" };
}

describe("authoritative feed timestamps", () => {
  it("uses the newest server state for cards and the pinned shelf", () => {
    const old = state("l1", "2026-08-23T12:00:00.000Z", "clear");
    const latest = state("l1", "2026-08-23T12:00:02.000Z", "active");
    const frames = {
      l1: { monitorState: latest },
    } as unknown as Record<string, TargetFrameState>;
    const merged = authoritativeTargetStates([old], frames);
    expect(merged).toEqual([latest]);
    expect(targetObservationAt(["l1"], merged)).toBe(latest.lastObservedAt);
  });

  it("does not let an older replay replace a newer snapshot state", () => {
    const latest = state("l1", "2026-08-23T12:00:02.000Z", "clear");
    const replay = state("l1", "2026-08-23T12:00:00.000Z", "active");
    const merged = authoritativeTargetStates([latest], { l1: { monitorState: replay } as TargetFrameState });
    expect(merged).toEqual([latest]);
  });
});
