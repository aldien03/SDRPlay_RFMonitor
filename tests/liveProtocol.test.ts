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

describe("bounded incident copies in live messages", () => {
  it("keeps a worst-case incident small enough for frame metadata and a ten-incident state message", async () => {
    const { compactLiveEvent } = await import("../src/shared/liveProtocol");
    const { alertPresetValues } = await import("../src/shared/alertPolicy");
    const longText = "x".repeat(2_000);
    const event = {
      id: "e".repeat(36), dataDomain: "field", sessionId: "s".repeat(80), sessionIds: Array.from({ length: 12 }, (_, index) => `session-${index}-${"s".repeat(60)}`),
      kind: "gnss-energy-anomaly", detailKind: "partial-band", status: "interference-likely", severity: "medium", evidenceStrength: "Medium",
      evidenceBasis: longText.slice(0, 200), baselineFingerprintId: "f".repeat(64), ruleSetId: "rf-relative-mad-v1", observationId: "o".repeat(36),
      service: "gnss", bandId: "gps-l1", targetId: "gnss-l1-e1-b1c-sbas", bandLabel: "GPS L1", affectedRangeHz: [1, 2],
      disturbedRangesHz: Array.from({ length: 40 }, (_, index): [number, number] => [index * 10, index * 10 + 5]),
      trigger: {
        schemaVersion: 1, classifierVersion: "rf-alert-segments-1", detailKind: "partial-band", firedAt: new Date(0).toISOString(), observationId: "o".repeat(36),
        policy: { choice: "custom", source: "window", values: alertPresetValues("standard"), hash: "h".repeat(64) },
        reference: { lifecycle: "protected", kind: "approved", fingerprintId: "f".repeat(64), generationId: "12", revision: "r".repeat(80) },
        measured: { peakZ: 1, medianZ: 1, occupancyRatio: 1, widestSegmentRatio: 1, widestSegmentMedianZ: 1, peakFrequencyHz: 1, peakLevel: 1, usualLevelAtPeak: 1, levelAboveUsual: 1, burstPeakZ: 1 },
        rules: Array.from({ length: 6 }, () => ({ rule: "wideband", label: "Raised share of window", measured: 1, threshold: 1, unit: "ratio", met: true })),
        persistence: { votes: 3, window: 5, required: 3, exposureMs: 1, requiredExposureMs: 1 },
        disturbedRangesHz: Array.from({ length: 16 }, (_, index): [number, number] => [index, index + 1]),
        analyzedRangeHz: [1, 2], binWidthHz: 1,
      },
      timeline: Array.from({ length: 32 }, (_, index) => ({ at: new Date(index).toISOString(), code: "note", detail: longText.slice(0, 200) })),
      observed: longText.slice(0, 400), recommendedAction: longText.slice(0, 200), startedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
      notes: Array.from({ length: 50 }, (_, index) => ({ id: `note-${index}`, timestamp: new Date(0).toISOString(), text: longText })),
      metrics: { timestamp: new Date(0).toISOString(), bandId: "gps-l1", meanLevel: 1, peakLevel: 1, baselineLevel: 1, baselineDelta: 1, occupiedRatio: 1, overload: false, medianRobustZ: 1, peakRobustZ: 1, maximumOccupiedWidthRatio: 1 },
    } as never;
    const withTrigger = Buffer.byteLength(JSON.stringify(compactLiveEvent(event, true)));
    const withoutTrigger = Buffer.byteLength(JSON.stringify(compactLiveEvent(event, false)));
    expect(withTrigger).toBeLessThan(16 * 1024);
    expect(withTrigger + 10 * withoutTrigger).toBeLessThan(128 * 1024 - 32 * 1024);
    expect((compactLiveEvent(event) as { timeline: unknown[] }).timeline).toHaveLength(4);
    expect((compactLiveEvent(event) as { disturbedRangesHz: unknown[] }).disturbedRangesHz).toHaveLength(16);
  });
});
