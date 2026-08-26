import type { LiveSubscription } from "./types";

export const MAX_VISIBLE_TARGETS = 9;
export const MAX_DETAIL_TARGETS = 9;

export interface NormalizedLiveSubscription extends LiveSubscription {
  protocolVersion: 1 | 2;
  visibleTargetIds: string[];
  detailTargetIds: string[];
  visibleFeedIds: string[];
  detailFeedIds: string[];
}

function uniqueStrings(input: unknown, validTargets?: ReadonlySet<string>, limit = MAX_VISIBLE_TARGETS): string[] {
  if (!Array.isArray(input) || limit <= 0) return [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || !value || seen.has(value) || (validTargets && !validTargets.has(value))) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

export function normalizeLiveSubscription(
  input: Partial<LiveSubscription>,
  validTargets?: ReadonlySet<string>,
  validFeeds?: ReadonlySet<string>,
): NormalizedLiveSubscription | undefined {
  const rateHz = Number(input.rateHz);
  if (input.type !== "subscribe" || ![0.2, 2, 4].includes(rateHz)) return undefined;
  if (rateHz === 4 && !input.engineer) return undefined;
  const protocolVersion = input.protocolVersion ?? 1;
  if (protocolVersion !== 1 && protocolVersion !== 2) return undefined;
  const requestedVisible = input.visibleTargetIds ?? input.pinnedTargetIds;
  const visibleTargetIds = uniqueStrings(requestedVisible, validTargets);
  const visible = new Set(visibleTargetIds);
  const detailTargetIds = uniqueStrings(input.detailTargetIds, validTargets, Math.min(MAX_DETAIL_TARGETS, visibleTargetIds.length))
    .filter((targetId) => visible.has(targetId));
  const visibleFeedIds = uniqueStrings(input.visibleFeedIds, validFeeds, MAX_VISIBLE_TARGETS - visibleTargetIds.length);
  const visibleFeeds = new Set(visibleFeedIds);
  const detailFeedIds = uniqueStrings(input.detailFeedIds, validFeeds, MAX_DETAIL_TARGETS - detailTargetIds.length)
    .filter((feedId) => visibleFeeds.has(feedId));
  return {
    type: "subscribe",
    protocolVersion,
    rateHz: rateHz as LiveSubscription["rateHz"],
    engineer: Boolean(input.engineer),
    visibleTargetIds,
    detailTargetIds,
    visibleFeedIds,
    detailFeedIds,
  };
}

export function liveSubscriptionSignature(subscription: NormalizedLiveSubscription): string {
  const visible = [...subscription.visibleTargetIds].sort();
  const detail = [...subscription.detailTargetIds].sort();
  const visibleFeeds = [...subscription.visibleFeedIds].sort();
  const detailFeeds = [...subscription.detailFeedIds].sort();
  return JSON.stringify([
    subscription.protocolVersion,
    subscription.rateHz,
    subscription.engineer,
    visible,
    detail,
    visibleFeeds,
    detailFeeds,
  ]);
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}
