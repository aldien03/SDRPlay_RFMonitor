import { describe, expect, it } from "vitest";
import {
  baselineFingerprintId,
  createBaselineFingerprint,
  DEFAULT_THRESHOLDS,
  detectionRuleFingerprint,
  DetectionEngine,
} from "../src/shared/detection";
import { STARTRACK_BAND } from "./catalogFixture";
import type { TargetObservation } from "../src/shared/types";

const BIN_COUNT = 2048;
const band = STARTRACK_BAND;
const targetId = band.captureTargetId ?? `target-${band.id}`;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function observationAt(sequence: number, bins: Uint8Array): TargetObservation {
  const fingerprint = createBaselineFingerprint({
    dataDomain: "test",
    receiverIdentity: "synthetic:test-receiver-0",
    receiverKey: "receiver-0",
    deviceName: "RSPdx",
    deviceSerial: "test-serial",
    sdrconnectVersion: "1.0-test",
    activeAntenna: "Antenna A",
    gainProfileId: "fixed-test-gain",
    targetId,
    centerHz: band.centerHz,
    sampleRateHz: 10_000_000,
    inputBinCount: BIN_COUNT,
    analysisStartBin: 0,
    analysisEndBin: BIN_COUNT,
    analysisMaskHash: "all-bins",
    spectrumReference: 0,
    spectrumBase: 0,
    catalogVersion: "test-v3",
    detectionRuleHash: detectionRuleFingerprint(DEFAULT_THRESHOLDS),
  });
  const observedAt = new Date(sequence * 1_000).toISOString();
  return {
    dataDomain: "test",
    id: `observation-${sequence}`,
    visitId: `visit-${sequence}`,
    configurationEpoch: 1,
    tuneEpoch: sequence + 1,
    visitEpoch: sequence + 1,
    targetId,
    receiver: 0,
    bandId: band.id,
    affectedBandIds: [band.id],
    observedAt,
    firstFrameAt: new Date(sequence * 1_000 - 1_000).toISOString(),
    lastFrameAt: observedAt,
    exposureMs: 1_000,
    acceptedFrameCount: 3,
    bins,
    confirmedCenterHz: band.centerHz,
    confirmedSampleRateHz: 10_000_000,
    tuneConfirmedAt: new Date(sequence * 1_000 - 1_250).toISOString(),
    fingerprint: { ...fingerprint, targetId },
    overload: false,
    healthComplete: true,
  };
}

/** Quiet noise floor with a periodic wideband rise, so both learning and anomaly paths run. */
function sequenceBins(count: number): Uint8Array[] {
  const random = seededRandom(7);
  return Array.from({ length: count }, (_, index) => {
    const bins = new Uint8Array(BIN_COUNT);
    for (let bin = 0; bin < BIN_COUNT; bin += 1) bins[bin] = Math.round(40 + 6 * Math.sin(bin / 90) + random() * 5);
    if (index > 320 && index % 40 === 0) for (let bin = 300; bin < 1700; bin += 1) bins[bin] = Math.min(255, bins[bin] + 70);
    return bins;
  });
}

function createEngine(forceDerive: boolean) {
  const engine = new DetectionEngine(DEFAULT_THRESHOLDS, seededRandom(99));
  const internals = engine as unknown as {
    histogram: Uint16Array;
    deriveRobustBaseline: (state: { derivedRevision: number }) => void;
  };
  let histogramFills = 0;
  const originalFill = internals.histogram.fill.bind(internals.histogram);
  internals.histogram.fill = ((...args: Parameters<Uint16Array["fill"]>) => { histogramFills += 1; return originalFill(...args); }) as Uint16Array["fill"];
  if (forceDerive) {
    // The previous behaviour: recompute the robust baseline on every observation.
    const original = internals.deriveRobustBaseline.bind(engine);
    internals.deriveRobustBaseline = (state) => { state.derivedRevision = -1; original(state); };
  }
  return { engine, fills: () => histogramFills };
}

function normalize(value: unknown): string {
  return JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

describe("robust baseline derivation cache", () => {
  const observations = sequenceBins(900);

  it("gives results identical to recomputing on every observation", () => {
    const cached = createEngine(false);
    const forced = createEngine(true);
    let anomalies = 0;
    observations.forEach((bins, index) => {
      const a = cached.engine.analyzeObservation(observationAt(index, bins), band);
      const b = forced.engine.analyzeObservation(observationAt(index, bins), band);
      expect(normalize(a)).toBe(normalize(b));
      if (a.disposition === "anomalous") anomalies += 1;
    });
    // The comparison must have exercised the alerting path, not only learning.
    expect(anomalies).toBeGreaterThan(0);
    expect(normalize(cached.engine.getBaselineStates())).toBe(normalize(forced.engine.getBaselineStates()));
    const key = `${targetId}:${baselineFingerprintId(observationAt(0, observations[0]).fingerprint)}`;
    const states = (engine: DetectionEngine) => (engine as unknown as { states: Map<string, { medians: Uint8Array; mads: Uint8Array }> }).states.get(key)!;
    expect([...states(cached.engine).medians]).toEqual([...states(forced.engine).medians]);
    expect([...states(cached.engine).mads]).toEqual([...states(forced.engine).mads]);
  });

  it("skips the derivation on observations that leave the reservoir unchanged", () => {
    const cached = createEngine(false);
    const forced = createEngine(true);
    observations.forEach((bins, index) => {
      cached.engine.analyzeObservation(observationAt(index, bins), band);
      forced.engine.analyzeObservation(observationAt(index, bins), band);
    });
    // While the 256-row reservoir fills every observation changes it, so this short run saves ~35%.
    expect(cached.fills()).toBeLessThan(forced.fills() * 0.7);
  });

  it("recomputes on a small fraction of observations once the reservoir has filled", () => {
    const long = sequenceBins(3_000);
    const cached = createEngine(false);
    long.forEach((bins, index) => cached.engine.analyzeObservation(observationAt(index, bins), band));
    // Each recompute makes 2 x 2048 histogram clears. Expected recomputes ~ 256 + 256 ln(3000/256) ~ 890.
    const recomputes = cached.fills() / (2 * BIN_COUNT);
    expect(recomputes).toBeLessThan(1_100);
    expect(recomputes).toBeLessThan(long.length * 0.4);
  });
});
