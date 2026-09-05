import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { feedManagerScopeCopy, feedMetricReadout, metricsForFrame, PinnedShelf, signalStateForFeed } from "../src/client/SignalWall";
import { resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { MonitorFeed, SignalMetricSample, SpectrumFrame, SweepCycle } from "../src/shared/types";

const radioFeed: MonitorFeed = {
  id: "survey-4dx",
  label: "4DX radio",
  shortLabel: "4DX",
  description: "Stitched radio survey",
  service: "4dx",
  category: "radio",
  kind: "stitched-sweep",
  enabled: true,
  coverageLabel: "225-400 MHz",
  targetIds: ["4dx-1", "4dx-2", "4dx-3"],
  bandIds: ["4dx-1", "4dx-2", "4dx-3"],
  startHz: 225_000_000,
  endHz: 400_000_000,
  centerHz: 312_500_000,
  priority: false,
};

const operatorSummary = resolveOperatorSummary({
  generatedAt: "2026-08-23T04:00:04.000Z",
  serverBuildId: "test",
  dataDomain: "field",
  monitoring: { receiverOnline: true, dataFresh: true, paused: false, alertActive: false, recovering: false, candidateActive: false, detectingActive: false, checking: false },
  recording: { state: "recording" },
  currentHealth: { state: "normal" },
  productionQualification: { state: "pending", ready: false },
  observation: { at: "2026-08-23T04:00:04.000Z", coverage: "observed" },
});

describe("Signal Wall pinned shelf", () => {
  it("uses a stitched survey completion time instead of physical target freshness", () => {
    const now = Date.parse("2026-08-23T04:00:04.000Z");
    const sweepCycles: SweepCycle[] = [{
      id: "4dx-cycle-1",
      feedId: radioFeed.id,
      status: "complete",
      startedAt: "2026-08-23T04:00:00.000Z",
      lastCompletedAt: "2026-08-23T04:00:00.000Z",
      completedSegments: 3,
      totalSegments: 3,
      progress: 100,
      elapsedMs: 4_000,
      segments: [],
      waterfall: [],
    }];

    const markup = renderToStaticMarkup(createElement(PinnedShelf, {
      feeds: [radioFeed],
      targets: [],
      targetStates: [],
      targetFrames: {},
      operatorSummary,
      sweepCycles,
      pinnedFeedIds: [radioFeed.id],
      selectedFeedId: radioFeed.id,
      now,
      onSelect: () => undefined,
      onManage: () => undefined,
    }));

    expect(markup).toContain("4 s ago");
    expect(markup).not.toContain("Not checked");
  });
});

describe("Signal Wall baseline trust", () => {
  const frame: SpectrumFrame = {
    id: "frame-1",
    timestamp: "2026-08-23T04:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    startHz: 1_570_000_000,
    endHz: 1_580_000_000,
    bins: new Uint8Array([20, 22, 24]),
    source: "sdrconnect",
    calibrated: false,
  };
  const supplied: SignalMetricSample = {
    timestamp: frame.timestamp,
    bandId: frame.bandId,
    meanLevel: 22,
    peakLevel: 24,
    baselineLevel: 19,
    baselineDelta: 3,
    occupiedRatio: 0,
    overload: false,
  };

  it("uses only metrics supplied for the exact displayed band", () => {
    expect(metricsForFrame(frame, supplied)).toBe(supplied);
    expect(metricsForFrame(frame, { ...supplied, bandId: "gps-l2" })).toBeUndefined();
  });

  it("does not fabricate a usual level when detector metrics are absent", () => {
    expect(metricsForFrame(frame, undefined)).toBeUndefined();
  });
});

describe("Signal Wall canonical incident state", () => {
  const incidentSummary = resolveOperatorSummary({
    generatedAt: "2026-08-23T04:00:04.000Z",
    serverBuildId: "test",
    dataDomain: "test",
    monitoring: {
      receiverOnline: true,
      dataFresh: true,
      paused: false,
      alertActive: true,
      recovering: false,
      candidateActive: false,
      detectingActive: false,
      checking: false,
    },
    recording: { state: "recording" },
    currentHealth: { state: "simulation" },
    productionQualification: { state: "pending", ready: false },
    affectedTargets: [{ id: "gnss-l1", label: "GNSS L1" }],
    observation: { at: "2026-08-23T04:00:04.000Z", coverage: "observed", targetId: "gnss-l1" },
    incident: {
      id: "synthetic-incident",
      lifecycle: "active",
      verdict: "Suspected RF interference",
      observation: "Relative RF energy stayed above normal.",
      recommendedAction: "Keep recording.",
      evidenceStrength: "Low",
      startedAt: "2026-08-23T04:00:00.000Z",
      synthetic: true,
    },
  });

  it("keeps the affected card Alert when resource pressure suppresses its graph", () => {
    expect(signalStateForFeed({
      summary: incidentSummary,
      targetIds: ["gnss-l1"],
      measured: "checking",
      currentAvailable: false,
      unavailable: false,
    })).toBe("alert");
  });

  it("does not project one target's alert onto another feed", () => {
    expect(signalStateForFeed({
      summary: incidentSummary,
      targetIds: ["gnss-l5"],
      measured: "normal",
      currentAvailable: false,
      unavailable: false,
    })).toBe("checking");
  });
});


describe("feed metric readout", () => {
  const frame: SpectrumFrame = {
    id: "frame-1",
    timestamp: "2026-08-23T04:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    startHz: 1_570_000_000,
    endHz: 1_580_000_000,
    bins: new Uint8Array([20, 22, 24]),
    source: "sdrconnect",
    calibrated: false,
  };
  const metrics: SignalMetricSample = {
    timestamp: frame.timestamp,
    bandId: frame.bandId,
    meanLevel: 22,
    peakLevel: 24.4,
    baselineLevel: 19,
    baselineDelta: 3.2,
    occupiedRatio: 0.42,
    overload: false,
  };

  it("shows no numbers when the feed is off or unavailable", () => {
    expect(feedMetricReadout({ frame, metrics, baselineAvailable: true, off: true, unavailable: false })).toBeUndefined();
    expect(feedMetricReadout({ frame, metrics, baselineAvailable: true, off: false, unavailable: true })).toBeUndefined();
  });

  it("reports only Receiver overloaded when the receiver is saturated", () => {
    expect(feedMetricReadout({ frame, metrics: { ...metrics, overload: true }, baselineAvailable: true, off: false, unavailable: false }))
      .toEqual({ chips: ["Receiver overloaded"], overload: true });
  });

  it("omits the vs usual chip when no baseline is available", () => {
    expect(feedMetricReadout({ frame, metrics, baselineAvailable: false, off: false, unavailable: false }))
      .toEqual({ chips: ["Peak 24/255", "Busy 42%"], overload: false });
  });

  it("shows a plus prefix for a positive baseline delta", () => {
    expect(feedMetricReadout({ frame, metrics, baselineAvailable: true, off: false, unavailable: false }))
      .toEqual({ chips: ["Peak 24/255", "+3 vs usual", "Busy 42%"], overload: false });
  });

  it("uses the U+2212 minus sign, not a hyphen, for a negative baseline delta", () => {
    const readout = feedMetricReadout({ frame, metrics: { ...metrics, baselineDelta: -5 }, baselineAvailable: true, off: false, unavailable: false });
    expect(readout?.chips[1]).toBe("−5 vs usual");
  });

  const placement = { startHz: 1_575_100_000, endHz: 1_575_700_000, widthHz: 600_000, offsetHz: 400_000, coverageRatio: 0.12 };

  it("appends the width chip last, leaving the earlier chips unchanged, when a placement is supplied", () => {
    expect(feedMetricReadout({ frame, metrics, baselineAvailable: true, off: false, unavailable: false, placement }))
      .toEqual({ chips: ["Peak 24/255", "+3 vs usual", "Busy 42%", "0.60 MHz wide"], overload: false });
  });

  it("still reports only Receiver overloaded when a placement is supplied and the receiver is saturated", () => {
    expect(feedMetricReadout({ frame, metrics: { ...metrics, overload: true }, baselineAvailable: true, off: false, unavailable: false, placement }))
      .toEqual({ chips: ["Receiver overloaded"], overload: true });
  });
});

describe("feed manager scope", () => {
  it("explains that pinnable windows come from the Monitoring selection", () => {
    expect(feedManagerScopeCopy(1)).toBe(
      "This list shows the 1 frequency window your Monitoring selection covers. To pin another window, add it in Monitoring first.",
    );
  });

  it("counts the covered windows so a short list is never unexplained", () => {
    expect(feedManagerScopeCopy(2)).toContain("2 frequency windows");
    expect(feedManagerScopeCopy(0)).toContain("0 frequency windows");
  });
});
