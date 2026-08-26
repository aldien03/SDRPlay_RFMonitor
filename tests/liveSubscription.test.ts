import { describe, expect, it } from "vitest";
import { liveSubscriptionSignature, normalizeLiveSubscription, sameStringSet } from "../src/shared/liveSubscription";

describe("live subscription normalization", () => {
  it("canonicalizes semantically identical target sets", () => {
    const first = normalizeLiveSubscription({ type: "subscribe", rateHz: 2, engineer: false, visibleTargetIds: ["b", "a", "a"], detailTargetIds: ["a"] });
    const second = normalizeLiveSubscription({ type: "subscribe", rateHz: 2, engineer: false, visibleTargetIds: ["a", "b"], detailTargetIds: ["a"] });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(liveSubscriptionSignature(first!)).toBe(liveSubscriptionSignature(second!));
  });

  it("treats empty targets as a valid status-only subscription", () => {
    expect(normalizeLiveSubscription({ type: "subscribe", rateHz: 0.2, engineer: false })).toMatchObject({
      visibleTargetIds: [],
      detailTargetIds: [],
    });
  });

  it("filters invalid targets and caps visible subscriptions at nine", () => {
    const valid = new Set(Array.from({ length: 12 }, (_, index) => `target-${index}`));
    const normalized = normalizeLiveSubscription({
      type: "subscribe",
      rateHz: 4,
      engineer: true,
      visibleTargetIds: [...valid, "unknown"],
      detailTargetIds: ["target-0", "unknown"],
    }, valid);
    expect(normalized?.visibleTargetIds).toHaveLength(9);
    expect(normalized?.detailTargetIds).toEqual(["target-0"]);
  });

  it("counts each logical survey as one stream instead of expanding its physical windows", () => {
    const validTargets = new Set(Array.from({ length: 12 }, (_, index) => `target-${index}`));
    const validFeeds = new Set(["survey-startrack", "survey-4dx"]);
    const normalized = normalizeLiveSubscription({
      type: "subscribe",
      protocolVersion: 2,
      rateHz: 2,
      engineer: false,
      visibleTargetIds: ["target-0", "target-1"],
      detailTargetIds: ["target-0"],
      visibleFeedIds: ["survey-startrack", "survey-4dx", "unknown-feed"],
      detailFeedIds: ["survey-4dx", "unknown-feed"],
    }, validTargets, validFeeds);

    expect(normalized).toMatchObject({
      visibleTargetIds: ["target-0", "target-1"],
      detailTargetIds: ["target-0"],
      visibleFeedIds: ["survey-startrack", "survey-4dx"],
      detailFeedIds: ["survey-4dx"],
    });
  });

  it("caps physical targets and logical feeds at nine combined streams", () => {
    const validTargets = new Set(Array.from({ length: 9 }, (_, index) => `target-${index}`));
    const validFeeds = new Set(["survey-startrack", "survey-4dx"]);
    const normalized = normalizeLiveSubscription({
      type: "subscribe",
      protocolVersion: 2,
      rateHz: 2,
      engineer: false,
      visibleTargetIds: [...validTargets].slice(0, 8),
      visibleFeedIds: ["survey-startrack", "survey-4dx"],
    }, validTargets, validFeeds)!;

    expect(normalized.visibleTargetIds).toHaveLength(8);
    expect(normalized.visibleFeedIds).toEqual(["survey-startrack"]);
    expect(normalized.visibleTargetIds.length + normalized.visibleFeedIds.length).toBe(9);
  });

  it("compares arrays as sets without serialization", () => {
    expect(sameStringSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameStringSet(["a"], ["a", "b"])).toBe(false);
  });

  it("accepts one legacy release while distinguishing protocol v2", () => {
    expect(normalizeLiveSubscription({ type: "subscribe", rateHz: 2, engineer: false })?.protocolVersion).toBe(1);
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 2, engineer: false })?.protocolVersion).toBe(2);
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 3 as 2, rateHz: 2, engineer: false })).toBeUndefined();
  });

  it("[trace:RES-017] reserves bounded rates for hidden, normal, and visible Engineer subscriptions", () => {
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 0.2, engineer: false })).toBeDefined();
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 2, engineer: false })).toBeDefined();
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 4, engineer: false })).toBeUndefined();
    expect(normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 4, engineer: true })).toBeDefined();
  });

  it("collapses 100,000 identical subscriptions to one semantic change", () => {
    let previous: string | undefined;
    let changes = 0;
    for (let index = 0; index < 100_000; index += 1) {
      const normalized = normalizeLiveSubscription({
        type: "subscribe",
        protocolVersion: 2,
        rateHz: 2,
        engineer: false,
        visibleTargetIds: index % 2 ? ["target-b", "target-a"] : ["target-a", "target-b"],
        detailTargetIds: ["target-a"],
      })!;
      const signature = liveSubscriptionSignature(normalized);
      if (signature !== previous) changes += 1;
      previous = signature;
    }
    expect(changes).toBe(1);
  });

  it("canonicalizes logical feed order in duplicate subscription signatures", () => {
    const first = normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 2, engineer: false, visibleFeedIds: ["survey-4dx", "survey-startrack"] })!;
    const second = normalizeLiveSubscription({ type: "subscribe", protocolVersion: 2, rateHz: 2, engineer: false, visibleFeedIds: ["survey-startrack", "survey-4dx"] })!;
    expect(liveSubscriptionSignature(first)).toBe(liveSubscriptionSignature(second));
  });
});
