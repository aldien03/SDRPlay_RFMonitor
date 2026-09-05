import { describe, expect, it } from "vitest";
import type { MonitorFeed } from "../src/shared/types";
import {
  DEFAULT_SIGNAL_WALL_PREFERENCES,
  parseSignalWallPreferences,
  reconcileSignalWallPreferences,
  SIGNAL_WALL_CAPACITY,
} from "../src/client/signalWallPreferences";

const feeds: MonitorFeed[] = Array.from({ length: 10 }, (_, index) => {
  const service = index === 1 ? "startrack" as const : index === 2 ? "4dx" as const : "gnss" as const;
  const category = service === "gnss" ? "navigation" as const : "radio" as const;
  const id = service === "gnss" ? `window-target-${index + 1}` : `survey-${service}`;
  return {
    id,
    label: `Feed ${index + 1}`,
    shortLabel: `F${index + 1}`,
    description: "Monitoring feed",
    service,
    category,
    kind: category === "radio" ? "stitched-sweep" as const : "capture-window" as const,
    enabled: true,
    coverageLabel: "Frequency",
    targetIds: [`target-${index + 1}`],
    bandIds: [index === 3 ? "gps-l2" : index === 4 ? "galileo-e5a" : `band-${index + 1}`],
    centerHz: 1_100_000_000 + index,
    startHz: 1_095_000_000 + index,
    endHz: 1_105_000_000 + index,
    priority: index === 0,
    focusTargetId: `target-${index + 1}`,
    focusBandId: `band-${index + 1}`,
    focusCenterHz: 1_100_000_000 + index,
  };
});

describe("Signal Wall browser preferences", () => {
  it("defaults to a 2x1 feed wall and repairs invalid stored data", () => {
    expect(parseSignalWallPreferences(null)).toMatchObject({ layout: "2x1", pinnedFeedIds: [] });
    expect(parseSignalWallPreferences("not json")).toMatchObject({ layout: "2x1", pinnedFeedIds: [] });
    expect(parseSignalWallPreferences(JSON.stringify({ layout: "invalid", pinnedFeedIds: ["a", "a", 2] }))).toEqual({
      schemaVersion: 4,
      layout: "2x1",
      pinnedFeedIds: ["a"],
      seeded: true,
      selectedFeedId: undefined,
    });
  });

  it("keeps up to nine feed pins independent of grid capacity", () => {
    const parsed = parseSignalWallPreferences(JSON.stringify({ layout: "1x1", pinnedFeedIds: feeds.map((feed) => feed.id) }));
    expect(parsed.pinnedFeedIds).toHaveLength(9);
    expect(SIGNAL_WALL_CAPACITY[parsed.layout]).toBe(1);
    expect(reconcileSignalWallPreferences(parsed, feeds).pinnedFeedIds).toEqual(feeds.slice(0, 9).map((feed) => feed.id));
  });

  it("retains stored pins while the backend feed catalog is loading", () => {
    const preferences = { schemaVersion: 4 as const, layout: "2x1" as const, pinnedFeedIds: [feeds[0].id], seeded: true, selectedFeedId: feeds[0].id };
    expect(reconcileSignalWallPreferences(preferences, [])).toBe(preferences);
  });

  it("maps v3 groups and selected targets to stable feed ids", () => {
    const legacy = parseSignalWallPreferences(null, JSON.stringify({
      schemaVersion: 3,
      layout: "2x1",
      pinnedGroupIds: ["gnss-gps", "service-startrack"],
      selectedTargetIds: { "gnss-gps": "target-1" },
    }));
    const migrated = reconcileSignalWallPreferences(legacy, feeds);
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      layout: "2x1",
      pinnedFeedIds: ["window-target-1", "survey-startrack"],
    });
    expect(migrated.legacyGroupIds).toBeUndefined();
  });

  it("chooses the priority GNSS window then the two radio surveys on first use", () => {
    const defaults = reconcileSignalWallPreferences(
      { schemaVersion: 4, layout: "2x1", pinnedFeedIds: ["missing"], seeded: false },
      feeds,
    );
    expect(defaults.pinnedFeedIds.slice(0, 3)).toEqual(["window-target-1", "survey-startrack", "survey-4dx"]);
    expect(defaults.selectedFeedId).toBe("survey-startrack");
    expect(defaults.seeded).toBe(true);
  });

  it("keeps a pin for a feed the operator switched off in Monitoring", () => {
    const offFeeds = feeds.map((feed, index) => index === 5 ? { ...feed, enabled: false, coverageLabel: "Off" } : feed);
    const chosen = reconcileSignalWallPreferences(
      { schemaVersion: 4, layout: "2x1", pinnedFeedIds: [offFeeds[0].id, offFeeds[5].id], seeded: true, selectedFeedId: offFeeds[5].id },
      offFeeds,
    );
    expect(chosen.pinnedFeedIds).toEqual([offFeeds[0].id, offFeeds[5].id]);
    expect(chosen.selectedFeedId).toBe(offFeeds[5].id);
  });

  it("drops only pins whose feed left the backend catalog", () => {
    const chosen = reconcileSignalWallPreferences(
      { schemaVersion: 4, layout: "2x1", pinnedFeedIds: [feeds[0].id, "retired-feed"], seeded: true },
      feeds,
    );
    expect(chosen.pinnedFeedIds).toEqual([feeds[0].id]);
  });

  it("respects an emptied wall instead of restoring the starter pins", () => {
    const cleared = reconcileSignalWallPreferences(
      { schemaVersion: 4, layout: "2x1", pinnedFeedIds: [], seeded: true },
      feeds,
    );
    expect(cleared.pinnedFeedIds).toEqual([]);
    expect(cleared.selectedFeedId).toBeUndefined();
    expect(reconcileSignalWallPreferences(cleared, feeds).pinnedFeedIds).toEqual([]);
  });

  it("still seeds starter pins once a service is enabled after a fully off catalog", () => {
    const allOff = feeds.map((feed) => ({ ...feed, enabled: false }));
    const waiting = reconcileSignalWallPreferences(DEFAULT_SIGNAL_WALL_PREFERENCES, allOff);
    expect(waiting.pinnedFeedIds).toEqual([]);
    expect(waiting.seeded).toBe(false);
    expect(reconcileSignalWallPreferences(waiting, feeds).pinnedFeedIds.length).toBeGreaterThan(0);
  });

  it("never seeds starter pins over a feed the operator switched off", () => {
    const offFeeds = feeds.map((feed, index) => index === 0 ? { ...feed, enabled: false } : feed);
    const seeded = reconcileSignalWallPreferences(DEFAULT_SIGNAL_WALL_PREFERENCES, offFeeds);
    expect(seeded.pinnedFeedIds).not.toContain(offFeeds[0].id);
  });
});
