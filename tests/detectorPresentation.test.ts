import { describe, expect, it } from "vitest";
import {
  detectorAnalysisForFrame,
  detectorAnomalyRanges,
  detectorBaselineAvailable,
  disturbancePlacement,
  disturbancePlacementCopy,
} from "../src/client/detectorPresentation";
import type { DetectorAnomalyBinRange, SignalMetricSample, SpectrumFrame } from "../src/shared/types";

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

// bin width 50 kHz over a 10 MHz window (1_570_000_000-1_580_000_000, 200 bins),
// analysed 50-150 (a 5 MHz analysed span with 2.5 MHz guard bands each side).
function placementFrame(anomalyBinRanges: DetectorAnomalyBinRange[], overrides: { analysisStartBin?: number; analysisEndBin?: number; overload?: boolean; binCount?: number } = {}): SpectrumFrame {
  const binCount = overrides.binCount ?? 200;
  return {
    id: "placement-frame",
    timestamp: "2026-08-23T00:00:00.000Z",
    receiver: 0,
    bandId: "gps-l1",
    startHz: 1_570_000_000,
    endHz: 1_580_000_000,
    bins: new Uint8Array(binCount).fill(30),
    source: "simulation",
    dataDomain: "test",
    calibrated: false,
    detectorAnalysis: {
      schemaVersion: 1,
      source: "relative-mad-detector",
      observationId: "observation-2",
      ruleSetId: "rf-relative-mad-v1",
      disposition: "anomalous",
      analyzedRangeHz: [1_572_500_000, 1_577_500_000],
      analysisStartBin: overrides.analysisStartBin ?? 50,
      analysisEndBin: overrides.analysisEndBin ?? 150,
      baselineAvailable: true,
      overload: overrides.overload ?? false,
      anomalyKind: "narrowband-spike",
      anomalyBinRanges,
    },
  };
}

describe("disturbancePlacement", () => {
  it("is undefined for a frame with no detector annotation", () => {
    const sample = placementFrame([{ startBin: 102, endBin: 114 }]);
    delete sample.detectorAnalysis;
    expect(disturbancePlacement(sample)).toBeUndefined();
  });

  it("is undefined when the annotation reports overload, even with anomaly ranges present", () => {
    const sample = placementFrame([{ startBin: 102, endBin: 114 }], { overload: true });
    expect(disturbancePlacement(sample)).toBeUndefined();
  });

  it("is undefined when anomalyBinRanges is empty", () => {
    const sample = placementFrame([]);
    expect(disturbancePlacement(sample)).toBeUndefined();
  });

  it("merges two anomaly ranges into one extent spanning the lowest start to the highest end", () => {
    const sample = placementFrame([{ startBin: 100, endBin: 110 }, { startBin: 60, endBin: 70 }]);
    const placement = disturbancePlacement(sample);
    expect(placement?.startHz).toBe(1_573_000_000);
    expect(placement?.endHz).toBe(1_575_500_000);
  });

  it("reports a negative offset and \"below the centre\" for a disturbance below the window centre", () => {
    const sample = placementFrame([{ startBin: 40, endBin: 60 }], { analysisStartBin: 0, analysisEndBin: 200 });
    const placement = disturbancePlacement(sample)!;
    expect(placement.offsetHz).toBeLessThan(0);
    expect(disturbancePlacementCopy(placement)).toContain("below the centre");
  });

  it("reports a positive offset and \"above the centre\" for a disturbance above the window centre", () => {
    const sample = placementFrame([{ startBin: 160, endBin: 180 }], { analysisStartBin: 0, analysisEndBin: 200 });
    const placement = disturbancePlacement(sample)!;
    expect(placement.offsetHz).toBeGreaterThan(0);
    expect(disturbancePlacementCopy(placement)).toContain("above the centre");
  });

  it("computes coverageRatio as a fraction of the analysed span, not the full frame", () => {
    // Full frame is 10 MHz; the analysed span (bins 50-150) is only 5 MHz, so
    // a naive full-frame denominator would silently halve the reported coverage.
    const sample = placementFrame([{ startBin: 102, endBin: 114 }]);
    const placement = disturbancePlacement(sample)!;
    expect(placement.widthHz).toBe(600_000);
    expect(placement.coverageRatio).toBeCloseTo(0.12, 10);
    expect(disturbancePlacementCopy(placement)).toContain("12% of the checked span");
  });
});

describe("disturbancePlacementCopy", () => {
  it("formats extent, width, offset and coverage joined with ·", () => {
    const sample = placementFrame([{ startBin: 102, endBin: 114 }]);
    const placement = disturbancePlacement(sample)!;
    expect(disturbancePlacementCopy(placement)).toBe(
      "1575.100-1575.700 MHz · 0.600 MHz wide · 0.400 MHz above the centre · 12% of the checked span",
    );
  });
});
