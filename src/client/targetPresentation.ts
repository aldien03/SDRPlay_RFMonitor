import type { ChannelMonitorState } from "../shared/types";
import type { TargetFrameState } from "./useMonitor";

function timestampMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

export function latestTimestamp(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => timestampMs(value) > -Infinity)
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0];
}

/** Select one newest server-authored state for each target. */
export function authoritativeTargetStates(
  snapshotStates: ChannelMonitorState[],
  targetFrames: Record<string, TargetFrameState>,
): ChannelMonitorState[] {
  const byTarget = new Map(snapshotStates.map((state) => [state.targetId, state]));
  for (const [targetId, frameState] of Object.entries(targetFrames)) {
    const current = byTarget.get(targetId);
    const candidate = frameState.monitorState;
    if (!current || timestampMs(candidate.lastObservedAt) >= timestampMs(current.lastObservedAt)) {
      byTarget.set(targetId, candidate);
    }
  }
  return [...byTarget.values()];
}

export function targetObservationAt(targetIds: string[], states: ChannelMonitorState[]): string | undefined {
  return latestTimestamp(targetIds.map((targetId) => states.find((state) => state.targetId === targetId)?.lastObservedAt));
}
