import { describe, expect, it } from "vitest";
import { compileScanTargets, describeMonitorTarget } from "../src/shared/bands";
import { coverageStateForGroup, createMonitorFeeds, createMonitorGroups, signalStateForTargets } from "../src/shared/monitorGroups";
import type { BandPreset, ChannelMonitorState, MonitorTarget, ServiceCoverageSummary } from "../src/shared/types";
import { FOUR_DX_BAND, GNSS_BANDS, STARTRACK_BAND, TEST_CATALOG } from "./catalogFixture";

function targetsFor(bands: BandPreset[]): MonitorTarget[] {
  return compileScanTargets(bands, 10_000_000).map((target) => ({
    ...describeMonitorTarget(target),
    expectedRevisitMs: 10_000,
    priority: target.coverage.some((coverage) => coverage.band.service === "gnss"),
  }));
}

function summaries(bands: BandPreset[]): ServiceCoverageSummary[] {
  return TEST_CATALOG.services.map((service) => ({
    service: service.id,
    label: service.label,
    description: service.description,
    enabled: bands.some((band) => band.service === service.id),
    coverageLabel: bands.some((band) => band.service === service.id) ? "Configured coverage" : "Disabled",
    targetCount: bands.filter((band) => band.service === service.id).length,
    estimatedRevisitMs: 10_000,
  }));
}

describe("monitor groups", () => {
  it("combines GNSS signals by constellation and radio channels by coverage section", () => {
    const bands = [STARTRACK_BAND, FOUR_DX_BAND, ...GNSS_BANDS];
    const targets = targetsFor(bands);
    const groups = createMonitorGroups(TEST_CATALOG, bands, targets, summaries(bands));
    expect(groups.map((group) => group.id)).toEqual([
      "service-startrack",
      "service-4dx",
      "gnss-gps",
      "gnss-galileo",
      "gnss-glonass",
      "gnss-beidou",
      "gnss-sbas",
    ]);
    expect(groups.find((group) => group.id === "gnss-gps")?.members.map((member) => member.label)).toEqual(["L1", "L2", "L5"]);
    expect(groups.find((group) => group.id === "gnss-galileo")?.members.map((member) => member.label)).toEqual(["E1", "E5a", "E5b", "E6"]);
    expect(groups.find((group) => group.id === "service-startrack")!.members.length).toBeGreaterThan(1);
    expect(groups.find((group) => group.id === "service-startrack")!.members.length).toBeLessThan(STARTRACK_BAND.channelCount!);
    expect(groups.find((group) => group.id === "service-4dx")!.members.every((member) => member.label.startsWith("Channels"))).toBe(true);
  });

  it("keeps disabled service and constellation groups visible as Off", () => {
    const gpsL1 = GNSS_BANDS.find((band) => band.constellation === "GPS" && band.signal === "L1")!;
    const bands = [STARTRACK_BAND, gpsL1];
    const groups = createMonitorGroups(TEST_CATALOG, bands, targetsFor(bands), summaries(bands));
    expect(groups.find((group) => group.id === "gnss-gps")).toMatchObject({ enabled: true, coverageLabel: "L1" });
    expect(groups.find((group) => group.id === "gnss-galileo")).toMatchObject({ enabled: false, coverageLabel: "Off" });
    expect(groups.find((group) => group.id === "service-4dx")).toMatchObject({ enabled: false, coverageLabel: "Off" });
  });

  it("builds radio survey feeds and one shared GNSS feed per physical capture target", () => {
    const bands = [STARTRACK_BAND, FOUR_DX_BAND, ...GNSS_BANDS];
    const targets = targetsFor(bands);
    const feeds = createMonitorFeeds(TEST_CATALOG, bands, targets, summaries(bands));
    expect(feeds.find((feed) => feed.id === "survey-startrack")).toMatchObject({ kind: "stitched-sweep", category: "radio" });
    expect(feeds.find((feed) => feed.id === "survey-4dx")).toMatchObject({ kind: "stitched-sweep", category: "radio" });
    const sharedL1 = feeds.find((feed) => feed.bandIds.includes("gps-l1") && feed.bandIds.includes("galileo-e1") && feed.bandIds.includes("beidou-b1c"));
    expect(sharedL1).toMatchObject({
      label: "GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1",
      shortLabel: "L1 / E1 / B1C",
      kind: "capture-window",
      priority: true,
    });
    expect(feeds.filter((feed) => feed.bandIds.includes("gps-l2"))).toHaveLength(1);
  });

  it("separates signal condition from scan coverage", () => {
    const gpsL1 = GNSS_BANDS.find((band) => band.constellation === "GPS" && band.signal === "L1")!;
    const targets = targetsFor([gpsL1]);
    const group = createMonitorGroups(TEST_CATALOG, [gpsL1], targets, summaries([gpsL1])).find((candidate) => candidate.id === "gnss-gps")!;
    const now = Date.now();
    const states: ChannelMonitorState[] = targets.map((target) => ({
      targetId: target.id,
      lifecycle: "clear",
      candidateCount: 0,
      clearCount: 0,
      requiredCount: 3,
      lastObservedAt: new Date(now - 1_000).toISOString(),
      baselineLifecycle: "protected",
      observationDisposition: "clean",
    }));
    expect(signalStateForTargets(group.targetIds, states)).toBe("normal");
    expect(coverageStateForGroup(group, states, targets, now, false, true)).toBe("live");
    states[0] = { ...states[0], baselineLifecycle: "provisional" };
    expect(signalStateForTargets(group.targetIds, states)).toBe("checking");
    states[0] = { ...states[0], baselineLifecycle: "protected" };
    states[0] = { ...states[0], observationDisposition: "unknown" };
    expect(signalStateForTargets(group.targetIds, states)).toBe("checking");
    states[0] = { ...states[0], lifecycle: "detecting" };
    expect(signalStateForTargets(group.targetIds, states)).toBe("checking");
    expect(coverageStateForGroup(group, states, targets, now, true, true)).toBe("paused");
    expect(coverageStateForGroup(group, states, targets, now, false, false)).toBe("offline");
  });
});
