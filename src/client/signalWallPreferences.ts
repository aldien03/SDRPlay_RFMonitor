import type { MonitorFeed } from "../shared/types";

export type SignalWallLayout = "1x1" | "2x1" | "2x2" | "3x3";

export interface SignalWallPreferences {
  schemaVersion: 4;
  layout: SignalWallLayout;
  pinnedFeedIds: string[];
  selectedFeedId?: string;
  legacyGroupIds?: string[];
  legacyTargetIds?: string[];
  legacySelectedTargetIds?: Record<string, string>;
}

export const SIGNAL_WALL_STORAGE_KEY = "rf-monitor-signal-wall-v4";
export const LEGACY_SIGNAL_WALL_STORAGE_KEY = "rf-monitor-signal-wall-v3";
export const OLDEST_SIGNAL_WALL_STORAGE_KEY = "rf-monitor-signal-wall-v2";

export const SIGNAL_WALL_CAPACITY: Record<SignalWallLayout, number> = {
  "1x1": 1,
  "2x1": 2,
  "2x2": 4,
  "3x3": 9,
};

export const DEFAULT_SIGNAL_WALL_PREFERENCES: SignalWallPreferences = {
  schemaVersion: 4,
  layout: "2x1",
  pinnedFeedIds: [],
};

function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, limit)
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function parseSignalWallPreferences(value: string | null, legacyValue: string | null = null): SignalWallPreferences {
  const source = value ?? legacyValue;
  if (!source) return DEFAULT_SIGNAL_WALL_PREFERENCES;
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const layout = typeof parsed.layout === "string" && parsed.layout in SIGNAL_WALL_CAPACITY
      ? parsed.layout as SignalWallLayout
      : "2x1";
    if (Array.isArray(parsed.pinnedFeedIds)) {
      const pinnedFeedIds = stringArray(parsed.pinnedFeedIds, 9);
      const selectedFeedId = typeof parsed.selectedFeedId === "string" ? parsed.selectedFeedId : undefined;
      return { schemaVersion: 4, layout, pinnedFeedIds, selectedFeedId };
    }
    if (Array.isArray(parsed.pinnedGroupIds)) {
      return {
        schemaVersion: 4,
        layout,
        pinnedFeedIds: [],
        legacyGroupIds: stringArray(parsed.pinnedGroupIds, 9),
        legacySelectedTargetIds: stringRecord(parsed.selectedTargetIds),
      };
    }
    return {
      schemaVersion: 4,
      layout,
      pinnedFeedIds: [],
      legacyTargetIds: stringArray(parsed.pinnedTargetIds, 9),
    };
  } catch {
    return DEFAULT_SIGNAL_WALL_PREFERENCES;
  }
}

function feedForTarget(targetId: string, feeds: MonitorFeed[]): MonitorFeed | undefined {
  return feeds.find((feed) => feed.targetIds.includes(targetId));
}

function feedForLegacyGroup(groupId: string, selectedTargetIds: Record<string, string>, feeds: MonitorFeed[]): MonitorFeed | undefined {
  if (groupId === "service-startrack") return feeds.find((feed) => feed.id === "survey-startrack");
  if (groupId === "service-4dx") return feeds.find((feed) => feed.id === "survey-4dx");
  const targetId = selectedTargetIds[groupId];
  if (targetId) return feedForTarget(targetId, feeds);
  const constellation = groupId.replace("gnss-", "").toLowerCase();
  return feeds.find((feed) => feed.category === "navigation" && feed.label.toLowerCase().includes(constellation));
}

export function reconcileSignalWallPreferences(
  preferences: SignalWallPreferences,
  feeds: MonitorFeed[],
): SignalWallPreferences {
  if (!feeds.length) return preferences;
  const available = new Set(feeds.filter((feed) => feed.enabled).map((feed) => feed.id));
  let pinnedFeedIds = preferences.pinnedFeedIds.filter((feedId) => available.has(feedId)).slice(0, 9);

  if (!pinnedFeedIds.length && preferences.legacyGroupIds?.length) {
    pinnedFeedIds = preferences.legacyGroupIds
      .map((groupId) => feedForLegacyGroup(groupId, preferences.legacySelectedTargetIds ?? {}, feeds)?.id)
      .filter((feedId): feedId is string => Boolean(feedId && available.has(feedId)))
      .filter((feedId, index, values) => values.indexOf(feedId) === index)
      .slice(0, 9);
  }
  if (!pinnedFeedIds.length && preferences.legacyTargetIds?.length) {
    pinnedFeedIds = preferences.legacyTargetIds
      .map((targetId) => feedForTarget(targetId, feeds)?.id)
      .filter((feedId): feedId is string => Boolean(feedId && available.has(feedId)))
      .filter((feedId, index, values) => values.indexOf(feedId) === index)
      .slice(0, 9);
  }
  if (!pinnedFeedIds.length) {
    const gpsL2 = feeds.find((feed) => feed.category === "navigation" && feed.bandIds.includes("gps-l2"));
    const galileoE5a = feeds.find((feed) => feed.category === "navigation" && feed.bandIds.includes("galileo-e5a"));
    const defaults = [
      ...feeds.filter((feed) => feed.category === "navigation" && feed.priority),
      ...feeds.filter((feed) => feed.id === "survey-startrack"),
      ...feeds.filter((feed) => feed.id === "survey-4dx"),
      ...(gpsL2 ? [gpsL2] : []),
      ...(galileoE5a ? [galileoE5a] : []),
      ...feeds.filter((feed) => feed.category === "navigation" && !feed.priority),
      ...feeds.filter((feed) => feed.category === "radio" && !["survey-startrack", "survey-4dx"].includes(feed.id)),
    ];
    pinnedFeedIds = defaults.map((feed) => feed.id).filter((feedId, index, values) => values.indexOf(feedId) === index).slice(0, 5);
  }

  const selectedFeedId = preferences.selectedFeedId && pinnedFeedIds.includes(preferences.selectedFeedId)
    ? preferences.selectedFeedId
    : pinnedFeedIds[1] ?? pinnedFeedIds[0];
  return { schemaVersion: 4, layout: preferences.layout, pinnedFeedIds, selectedFeedId };
}
