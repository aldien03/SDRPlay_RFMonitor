import type { MonitorFeed } from "../shared/types";
import { SIGNAL_WALL_CAPACITY, type SignalWallLayout, type SignalWallPreferences } from "./signalWallPreferences";

export function normalVisibleFeedIds(preferences: SignalWallPreferences): string[] {
  const capacity = SIGNAL_WALL_CAPACITY[preferences.layout];
  if (capacity === 1) {
    return [preferences.selectedFeedId ?? preferences.pinnedFeedIds[0]]
      .filter((value): value is string => Boolean(value));
  }
  const primary = preferences.pinnedFeedIds[0];
  const selected = preferences.selectedFeedId && preferences.selectedFeedId !== primary
    ? preferences.selectedFeedId
    : preferences.pinnedFeedIds[1];
  return [primary, selected, ...preferences.pinnedFeedIds.filter((id) => id !== primary && id !== selected)]
    .filter((value): value is string => Boolean(value))
    .slice(0, capacity);
}

/**
 * Surface an affected feed without changing saved pins. Once the target is no
 * longer active, the function returns the normal wall exactly as it was.
 */
export function surfacedVisibleFeedIds(input: {
  preferences: SignalWallPreferences;
  feeds: MonitorFeed[];
  /** Canonical server-owned affected targets, in display priority order. */
  affectedTargetIds?: string[];
  /** One-release compatibility input for older callers. */
  activeEventTargetId?: string;
  syntheticTargetId?: string;
}): string[] {
  const normal = normalVisibleFeedIds(input.preferences);
  const targetIds = input.syntheticTargetId
    ? [input.syntheticTargetId]
    : input.affectedTargetIds?.length
      ? input.affectedTargetIds
      : input.activeEventTargetId
        ? [input.activeEventTargetId]
        : [];
  const affected = targetIds
    .map((targetId) => input.feeds.find((feed) => feed.targetIds.includes(targetId)))
    .find((feed): feed is MonitorFeed => Boolean(feed));
  if (!affected) return normal;
  return [affected.id, ...normal.filter((id) => id !== affected.id)]
    .slice(0, SIGNAL_WALL_CAPACITY[input.preferences.layout]);
}

export function preferencesForWall(layout: SignalWallLayout, pinnedFeedIds: string[], selectedFeedId?: string): SignalWallPreferences {
  return { schemaVersion: 4, layout, pinnedFeedIds, selectedFeedId };
}
