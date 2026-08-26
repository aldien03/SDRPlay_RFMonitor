import { describe, expect, it } from "vitest";
import { CLIENT_DATA_LATE_AFTER_MS, decodeSpectrumEnvelope, encodeSpectrumEnvelope, LIVE_HEARTBEAT_INTERVAL_MS } from "../src/shared/liveProtocol";
import type { SignalMetricSample, SpectrumFrame } from "../src/shared/types";

const frame: SpectrumFrame = {
  id: "frame-1",
  timestamp: "2026-08-21T14:00:00.000Z",
  receiver: 0,
  bandId: "gnss-l1",
  startHz: 1_565_000_000,
  endHz: 1_585_000_000,
  bins: new Uint8Array([0, 17, 128, 255]),
  source: "sdrconnect",
  calibrated: false,
};

const metrics: SignalMetricSample = {
  timestamp: frame.timestamp,
  bandId: frame.bandId,
  meanLevel: 100,
  peakLevel: 255,
  baselineLevel: 40,
  baselineDelta: 60,
  occupiedRatio: 0.25,
  overload: false,
};

describe("binary live spectrum protocol", () => {
  it("sends at least two heartbeats before the browser fails closed", () => {
    expect(LIVE_HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(CLIENT_DATA_LATE_AFTER_MS);
  });
  it("[trace:HW-005] round-trips metadata and raw bins without JSON bin expansion", () => {
    const encoded = encodeSpectrumEnvelope(frame, metrics);
    const decoded = decodeSpectrumEnvelope(encoded);
    const { bins: _bins, ...frameMetadata } = frame;
    expect(decoded.frame).toEqual(frameMetadata);
    expect(decoded.frame).not.toHaveProperty("bins");
    expect(decoded.frame.calibrated).toBe(false);
    expect(decoded.bins).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.bins)).toEqual(Array.from(frame.bins));
    expect(decoded.metrics).toEqual(metrics);
    expect(encoded.byteLength).toBeLessThan(JSON.stringify({ frame, metrics }).length);
  });

  it("identifies completed stitched sweeps without putting bins in control JSON", () => {
    const encoded = encodeSpectrumEnvelope({ ...frame, bandId: "survey-startrack" }, { ...metrics, bandId: "survey-startrack" }, undefined, undefined, "survey-startrack");
    const decoded = decodeSpectrumEnvelope(encoded);

    expect(decoded.feedId).toBe("survey-startrack");
    expect(decoded.frame.bandId).toBe("survey-startrack");
    expect(Array.from(decoded.bins)).toEqual(Array.from(frame.bins));
  });

  it("preserves explicit synthetic exercise provenance", () => {
    const syntheticExercise = {
      synthetic: true as const,
      runId: "run-1",
      scenarioId: "wideband",
      scenarioVersion: "1.0.0",
      scenarioHash: "a".repeat(64),
      validationProtocolVersion: "rf-synthetic-validation-1",
      generatorVersion: "relative-fft-generator-1",
    };
    const decoded = decodeSpectrumEnvelope(encodeSpectrumEnvelope({ ...frame, source: "simulation", syntheticExercise }, metrics));
    expect(decoded.frame.syntheticExercise).toEqual(syntheticExercise);
  });

  it("preserves bounded detector-owned analysis metadata without expanding raw bins", () => {
    const detectorAnalysis = {
      schemaVersion: 1 as const,
      source: "relative-mad-detector" as const,
      observationId: "observation-1",
      ruleSetId: "rf-relative-mad-v1",
      disposition: "anomalous" as const,
      analyzedRangeHz: [1_571_000_000, 1_579_000_000] as [number, number],
      analysisStartBin: 1,
      analysisEndBin: 3,
      baselineAvailable: true,
      overload: false,
      anomalyKind: "narrowband-spike" as const,
      anomalyBinRanges: [{ startBin: 2, endBin: 3 }],
    };
    const decoded = decodeSpectrumEnvelope(encodeSpectrumEnvelope({ ...frame, detectorAnalysis }, metrics));
    expect(decoded.frame.detectorAnalysis).toEqual(detectorAnalysis);
    expect(decoded.bins).toBeInstanceOf(Uint8Array);
  });

  it("rejects invalid and truncated envelopes", () => {
    expect(() => decodeSpectrumEnvelope(new TextEncoder().encode("JSON"))).toThrow(/Unsupported/);
    expect(() => decodeSpectrumEnvelope(new Uint8Array([82, 70, 77, 49, 255, 255]))).toThrow(/Incomplete/);
  });
});
