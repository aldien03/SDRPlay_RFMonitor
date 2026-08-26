import { describe, expect, it } from "vitest";
import { surfacedVisibleFeedIds } from "../src/client/feedVisibility";
import type { MonitorFeed } from "../src/shared/types";
import type { SignalWallPreferences } from "../src/client/signalWallPreferences";

const feeds = [
  { id: "l1", targetIds: ["target-l1"] },
  { id: "l2", targetIds: ["target-l2"] },
  { id: "l5", targetIds: ["target-l5"] },
] as MonitorFeed[];

function preferences(layout: SignalWallPreferences["layout"] = "2x1"): SignalWallPreferences {
  return { schemaVersion: 4, layout, pinnedFeedIds: ["l1", "l2"], selectedFeedId: "l2" };
}

describe("affected-feed surfacing", () => {
  it("temporarily places an unpinned incident first without mutating preferences", () => {
    const saved = preferences();
    expect(surfacedVisibleFeedIds({ preferences: saved, feeds, activeEventTargetId: "target-l5" })).toEqual(["l5", "l1"]);
    expect(saved.pinnedFeedIds).toEqual(["l1", "l2"]);
    expect(surfacedVisibleFeedIds({ preferences: saved, feeds })).toEqual(["l1", "l2"]);
  });

  it("uses the affected feed in a one-card wall", () => {
    expect(surfacedVisibleFeedIds({ preferences: preferences("1x1"), feeds, activeEventTargetId: "target-l5" })).toEqual(["l5"]);
  });

  it("prefers canonical affected targets over the legacy active-event target", () => {
    expect(surfacedVisibleFeedIds({
      preferences: preferences(),
      feeds,
      affectedTargetIds: ["target-l5"],
      activeEventTargetId: "target-l2",
    })).toEqual(["l5", "l1"]);
  });

  it("keeps a synthetic exercise visibly distinct when both states exist", () => {
    expect(surfacedVisibleFeedIds({
      preferences: preferences(),
      feeds,
      activeEventTargetId: "target-l5",
      syntheticTargetId: "target-l2",
    })).toEqual(["l2", "l1"]);
  });
});
