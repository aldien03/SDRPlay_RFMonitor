import { describe, expect, it } from "vitest";
import {
  detectorAnalysisForFrame,
  detectorAnomalyRanges,
  detectorBaselineAvailable,
} from "../src/client/detectorPresentation";
import type { SignalMetricSample, SpectrumFrame } from "../src/shared/types";

function frame(): SpectrumFrame {
  return {
    id: "frame-1",
    timestamp: "2026-08-23T00:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    targetId: "gnss-l1-e1-b1c-sbas",
    startHz: 1_570_420_000,
    endHz: 1_580_420_000,
    bins: new Uint8Array(32).fill(30),
    source: "simulation",
    dataDomain: "test",
    calibrated: false,
    detectorAnalysis: {
      schemaVersion: 1,
      source: "relative-mad-detector",
      observationId: "observation-1",
      ruleSetId: "rf-relative-mad-v1",
      disposition: "anomalous",
      analyzedRangeHz: [1_571_420_000, 1_579_420_000],
      analysisStartBin: 3,
      analysisEndBin: 29,
      baselineAvailable: true,
      overload: false,
      anomalyKind: "narrowband-spike",
      anomalyBinRanges: [{ startBin: 15, endBin: 17 }],
    },
  };
}

const metrics: SignalMetricSample = {
  timestamp: "2026-08-23T00:00:00.000Z",
  bandId: "gps-l1",
  meanLevel: 31,
  peakLevel: 120,
  baselineLevel: 30,
  baselineDelta: 1,
  occupiedRatio: 0.03,
  overload: false,
};

describe("detector-authoritative graph presentation", () => {
  it("[trace:DET-202] uses only validated detector ranges and baseline availability", () => {
    const sample = frame();
    expect(detectorAnalysisForFrame(sample)).toBe(sample.detectorAnalysis);
    expect(detectorAnomalyRanges(sample)).toEqual([{ startBin: 15, endBin: 17 }]);
    expect(detectorBaselineAvailable(sample, metrics)).toBe(true);
  });

  it("[trace:TRUTH-004] fails closed when ranges escape the analysis span", () => {
    const sample = frame();
    sample.detectorAnalysis!.anomalyBinRanges = [{ startBin: 2, endBin: 17 }];
    expect(detectorAnalysisForFrame(sample)).toBeUndefined();
    expect(detectorAnomalyRanges(sample)).toEqual([]);
    expect(detectorBaselineAvailable(sample, metrics)).toBe(false);
  });

  it("keeps receiver overload distinct from red RF-anomaly ranges", () => {
    const sample = frame();
    sample.detectorAnalysis = {
      ...sample.detectorAnalysis!,
      overload: true,
      anomalyKind: undefined,
      anomalyBinRanges: [],
    };
    expect(detectorAnalysisForFrame(sample)?.overload).toBe(true);
    expect(detectorAnomalyRanges(sample)).toEqual([]);
  });
});
