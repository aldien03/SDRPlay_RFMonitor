import { describe, expect, it } from "vitest";
import {
  aggregateVisitFrames,
  analyzedFrequencyRange,
  baselineFingerprintId,
  centralAnalysisBinBounds,
  createBaselineFingerprint,
  DEFAULT_THRESHOLDS,
  detectionRuleFingerprint,
  DetectionEngine,
  type DetectionBaselineReference,
  projectDetectorAnalysisToFrame,
} from "../src/shared/detection";
import { GNSS_BANDS, STARTRACK_BAND } from "./catalogFixture";
import type { BandPreset, SpectrumFrame, TargetObservation } from "../src/shared/types";

const BIN_COUNT = 64;

function fingerprint(targetId: string) {
  return createBaselineFingerprint({
    dataDomain: "test",
    receiverIdentity: "synthetic:test-receiver-0",
    receiverKey: "receiver-0",
    deviceName: "RSPdx",
    deviceSerial: "test-serial",
    sdrconnectVersion: "1.0-test",
    activeAntenna: "Antenna A",
    gainProfileId: "fixed-test-gain",
    targetId,
    centerHz: STARTRACK_BAND.centerHz,
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
}

function observation(
  band: BandPreset,
  bins: Uint8Array,
  sequence: number,
  exposureMs = 1_000,
): TargetObservation {
  const targetId = band.captureTargetId ?? `target-${band.id}`;
  const observedAt = new Date(sequence * 1_000).toISOString();
  const baselineFingerprint = {
    ...fingerprint(targetId),
    targetId,
    centerHz: band.captureCenterHz ?? band.centerHz,
  };
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
    firstFrameAt: new Date(sequence * 1_000 - exposureMs).toISOString(),
    lastFrameAt: observedAt,
    exposureMs,
    acceptedFrameCount: 3,
    bins,
    confirmedCenterHz: baselineFingerprint.centerHz,
    confirmedSampleRateHz: 10_000_000,
    tuneConfirmedAt: new Date(sequence * 1_000 - exposureMs - 250).toISOString(),
    fingerprint: baselineFingerprint,
    overload: false,
    healthComplete: true,
  };
}

function referenceFor(
  sample: TargetObservation,
  lifecycle: "learning" | "provisional" | "reviewable" | "protected",
  observationCount: number,
  generation = "1",
): DetectionBaselineReference {
  const id = baselineFingerprintId(sample.fingerprint);
  return {
    descriptor: {
      dataDomain: sample.dataDomain,
      targetId: sample.targetId,
      lifecycle,
      fingerprintId: id,
      ...(lifecycle === "protected" ? { baselineId: `${id}:${generation}` } : {}),
      learningGenerationId: generation,
      observationCount,
      validCoverageRatio: observationCount ? 1 : 0,
      representativeHours: lifecycle === "reviewable" || lifecycle === "protected" ? 24 : 0,
      learningStartedAt: new Date(0).toISOString(),
      ...(lifecycle === "protected" ? { protectedAt: new Date(24 * 60 * 60_000).toISOString() } : {}),
    },
    medians: observationCount ? new Uint8Array(sample.bins.length).fill(30) : new Uint8Array(),
    mads: observationCount ? new Uint8Array(sample.bins.length) : new Uint8Array(),
  };
}

function train(engine: DetectionEngine, band = STARTRACK_BAND): void {
  for (let index = 0; index < 64; index += 1) {
    engine.analyzeObservation(observation(band, new Uint8Array(BIN_COUNT).fill(30), index), band);
  }
}

describe("visit aggregation", () => {
  it("uses the per-bin median and conservatively quantizes fractional monotonic exposure", () => {
    const band = STARTRACK_BAND;
    const targetId = band.captureTargetId ?? `target-${band.id}`;
    const makeFrame = (bins: number[], receivedMonotonicMs: number): SpectrumFrame => ({
      id: `frame-${receivedMonotonicMs}`,
      timestamp: new Date(receivedMonotonicMs).toISOString(),
      receiver: 0,
      bandId: band.id,
      targetId,
      visitId: "visit-1",
      configurationEpoch: 3,
      tuneEpoch: 7,
      visitEpoch: 11,
      startHz: band.startHz,
      endHz: band.endHz,
      bins: new Uint8Array(bins),
      source: "simulation",
      dataDomain: "test",
      calibrated: false,
      receivedMonotonicMs,
      confirmedCenterHz: band.centerHz,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(0).toISOString(),
    });
    const outcome = aggregateVisitFrames({
      frames: [makeFrame([10, 90], 100.125), makeFrame([30, 20], 200.5), makeFrame([20, 40], 300.875)],
      targetId,
      visitId: "visit-1",
      configurationEpoch: 3,
      tuneEpoch: 7,
      visitEpoch: 11,
      affectedBandIds: [band.id],
      fingerprint: { ...fingerprint(targetId), centerHz: band.centerHz, inputBinCount: 2, analysisEndBin: 2 },
    });
    expect(outcome.status).toBe("valid");
    if (outcome.status === "valid") {
      expect(Array.from(outcome.observation.bins)).toEqual([20, 40]);
      expect(outcome.observation.exposureMs).toBe(200);
      expect(Number.isSafeInteger(outcome.observation.exposureMs)).toBe(true);
    }
  });

  it("[trace:TRUTH-002] marks incomplete visits unknown rather than clean", () => {
    const band = STARTRACK_BAND;
    const targetId = band.captureTargetId ?? `target-${band.id}`;
    const outcome = aggregateVisitFrames({
      frames: [],
      targetId,
      visitId: "visit-empty",
      configurationEpoch: 1,
      tuneEpoch: 1,
      visitEpoch: 1,
      affectedBandIds: [band.id],
      fingerprint: fingerprint(targetId),
    });
    expect(outcome).toMatchObject({ status: "unknown", reason: "insufficient-frames" });
  });

  it.each([
    {
      label: "non-finite frame time",
      times: [Number.NaN, Number.NaN, Number.NaN],
      timestamps: ["invalid", "invalid", "invalid"],
    },
    {
      label: "reversed monotonic time",
      times: [300.75, 200.5, 100.25],
      timestamps: [
        new Date(300).toISOString(),
        new Date(200).toISOString(),
        new Date(100).toISOString(),
      ],
    },
  ])("fails closed when visit exposure has $label", ({ times, timestamps }) => {
    const band = STARTRACK_BAND;
    const targetId = band.captureTargetId ?? `target-${band.id}`;
    const frames = times.map((receivedMonotonicMs, index): SpectrumFrame => ({
      id: `invalid-time-frame-${index}`,
      timestamp: timestamps[index],
      receiver: 0,
      bandId: band.id,
      targetId,
      visitId: "visit-invalid-time",
      configurationEpoch: 3,
      tuneEpoch: 7,
      visitEpoch: 11,
      startHz: band.startHz,
      endHz: band.endHz,
      bins: new Uint8Array(2).fill(30),
      source: "simulation",
      dataDomain: "test",
      calibrated: false,
      receivedMonotonicMs,
      confirmedCenterHz: band.centerHz,
      confirmedSampleRateHz: 10_000_000,
      tuneConfirmedAt: new Date(0).toISOString(),
    }));
    const outcome = aggregateVisitFrames({
      frames,
      targetId,
      visitId: "visit-invalid-time",
      configurationEpoch: 3,
      tuneEpoch: 7,
      visitEpoch: 11,
      affectedBandIds: [band.id],
      fingerprint: { ...fingerprint(targetId), centerHz: band.centerHz, inputBinCount: 2, analysisEndBin: 2 },
    });
    expect(outcome).toMatchObject({ status: "unknown", reason: "receiver-unhealthy" });
  });
});

describe("detector frequency attribution", () => {
  it("[trace:HW-004] reports only the configured analyzed bins rather than the full capture span", () => {
    const sample = observation(STARTRACK_BAND, new Uint8Array(BIN_COUNT).fill(30), 1);
    sample.fingerprint = {
      ...sample.fingerprint,
      analysisStartBin: 6,
      analysisEndBin: 58,
    };
    expect(analyzedFrequencyRange(sample)).toEqual([
      sample.confirmedCenterHz - 4_062_500,
      sample.confirmedCenterHz + 4_062_500,
    ]);
  });

  it("excludes guard-only energy and projects anomaly ranges only inside the analyzed span", () => {
    const band = STARTRACK_BAND;
    const bounds = centralAnalysisBinBounds(BIN_COUNT, 8_000_000, 10_000_000);
    const targetId = band.captureTargetId ?? `target-${band.id}`;
    const makeAnalyzedObservation = (fullBins: Uint8Array, sequence: number) => {
      const sample = observation(band, fullBins.slice(bounds.startBin, bounds.endBin), sequence);
      sample.fingerprint = {
        ...fingerprint(targetId),
        centerHz: band.centerHz,
        inputBinCount: BIN_COUNT,
        analysisStartBin: bounds.startBin,
        analysisEndBin: bounds.endBin,
      };
      return sample;
    };
    const engine = new DetectionEngine();
    for (let index = 0; index < 64; index += 1) {
      engine.analyzeObservation(makeAnalyzedObservation(new Uint8Array(BIN_COUNT).fill(30), index), band);
    }

    const guardOnly = new Uint8Array(BIN_COUNT).fill(30);
    guardOnly.fill(250, 0, bounds.startBin);
    guardOnly.fill(250, bounds.endBin);
    const guardResult = engine.analyzeObservation(makeAnalyzedObservation(guardOnly, 70), band);
    expect(guardResult.disposition).toBe("clean");
    expect(guardResult.analysis.anomalyBinRanges).toEqual([]);

    const narrow = new Uint8Array(BIN_COUNT).fill(30);
    narrow[Math.floor((bounds.startBin + bounds.endBin) / 2)] = 230;
    let anomaly = engine.analyzeObservation(makeAnalyzedObservation(narrow, 71), band);
    anomaly = engine.analyzeObservation(makeAnalyzedObservation(narrow, 72), band);
    anomaly = engine.analyzeObservation(makeAnalyzedObservation(narrow, 73), band);
    expect(anomaly.analysis.anomalyBinRanges).toHaveLength(1);
    const projected = projectDetectorAnalysisToFrame({
      analysis: anomaly.analysis,
      frameBinCount: 32,
      analysisStartBin: 3,
      analysisEndBin: 29,
    });
    expect(projected.anomalyBinRanges[0].startBin).toBeGreaterThanOrEqual(projected.analysisStartBin);
    expect(projected.anomalyBinRanges[0].endBin).toBeLessThanOrEqual(projected.analysisEndBin);
    expect(projected.analyzedRangeHz).toEqual(anomaly.analysis.analyzedRangeHz);
  });
});

describe("detector memory bounds", () => {
  it("evicts old target fingerprints beyond the 32-state allocation bound", () => {
    const engine = new DetectionEngine();
    for (let index = 0; index < 40; index += 1) {
      const band = { ...STARTRACK_BAND, id: `band-${index}`, captureTargetId: `target-${index}` };
      engine.analyzeObservation(observation(band, new Uint8Array(BIN_COUNT).fill(30), index), band);
    }
    expect(engine.getBaselineStates()).toHaveLength(32);
    expect(engine.getAllocationBytes()).toBeLessThan(600_000);
  });
});

describe("authoritative persistent baseline integration", () => {
  it("uses the persistent generation for cold start and resets old candidate votes on restart", () => {
    const engine = new DetectionEngine();
    const quiet = new Uint8Array(BIN_COUNT).fill(30);
    const elevated = new Uint8Array(BIN_COUNT).fill(96);
    let reference = referenceFor(observation(STARTRACK_BAND, quiet, 0), "learning", 0, "1");
    for (let index = 0; index < 8; index += 1) {
      const sample = observation(STARTRACK_BAND, quiet, index);
      const result = engine.analyzeObservation(sample, STARTRACK_BAND, {
        referenceBaseline: reference,
        requireReferenceBaseline: true,
      });
      expect(result).toMatchObject({ disposition: "unknown", trainingEligible: true });
      reference = referenceFor(sample, "learning", index + 1, "1");
    }

    const firstCandidate = engine.analyzeObservation(
      observation(STARTRACK_BAND, elevated, 20),
      STARTRACK_BAND,
      { referenceBaseline: reference, requireReferenceBaseline: true },
    );
    expect(firstCandidate).toMatchObject({
      disposition: "unknown",
      trainingEligible: false,
      candidate: { kind: "wideband-noise-rise", hits: 1 },
      baseline: { lifecycle: "learning", learningGenerationId: "1" },
      analysis: { disposition: "unknown", baselineAvailable: false, anomalyBinRanges: [] },
    });

    const restarted = referenceFor(observation(STARTRACK_BAND, quiet, 21), "learning", 0, "2");
    const afterRestart = engine.analyzeObservation(
      observation(STARTRACK_BAND, elevated, 21),
      STARTRACK_BAND,
      { referenceBaseline: restarted, requireReferenceBaseline: true },
    );
    expect(afterRestart).toMatchObject({
      disposition: "unknown",
      trainingEligible: true,
      baseline: { learningGenerationId: "2", observationCount: 0 },
    });
    expect(afterRestart.candidate).toBeUndefined();
    expect(engine.getBaselineStates()).toEqual([
      expect.objectContaining({ learningGenerationId: "2", observationCount: 0, representativeHours: 0 }),
    ]);
  });

  it("does not train or vote on incomplete, mistuned, unhealthy, or stale-reference observations", () => {
    const engine = new DetectionEngine();
    const elevated = new Uint8Array(BIN_COUNT).fill(96);
    const first = observation(STARTRACK_BAND, elevated, 100);
    const reference = referenceFor(first, "protected", 256, "4");
    const firstVote = engine.analyzeObservation(first, STARTRACK_BAND, {
      referenceBaseline: reference,
      requireReferenceBaseline: true,
    });
    expect(firstVote.candidate?.hits).toBe(1);

    const invalid = observation(STARTRACK_BAND, elevated, 101);
    invalid.acceptedFrameCount = 2;
    expect(engine.analyzeObservation(invalid, STARTRACK_BAND, {
      referenceBaseline: reference,
      requireReferenceBaseline: true,
    })).toMatchObject({
      disposition: "unknown",
      trainingEligible: false,
      alertEligible: false,
      unknownReason: "observation-ineligible",
    });

    const mistuned = observation(STARTRACK_BAND, elevated, 102);
    mistuned.confirmedCenterHz += 1;
    expect(engine.analyzeObservation(mistuned, STARTRACK_BAND, {
      referenceBaseline: reference,
      requireReferenceBaseline: true,
    })).toMatchObject({ unknownReason: "observation-ineligible" });

    const unhealthy = observation(STARTRACK_BAND, elevated, 103);
    unhealthy.healthComplete = false;
    expect(engine.analyzeObservation(unhealthy, STARTRACK_BAND, {
      referenceBaseline: reference,
      requireReferenceBaseline: true,
    })).toMatchObject({ unknownReason: "observation-ineligible" });

    const staleReference = structuredClone(reference);
    staleReference.descriptor.fingerprintId = "0".repeat(64);
    expect(engine.analyzeObservation(observation(STARTRACK_BAND, elevated, 104), STARTRACK_BAND, {
      referenceBaseline: staleReference,
      requireReferenceBaseline: true,
    })).toMatchObject({ unknownReason: "baseline-mismatch", trainingEligible: false });

    const secondVote = engine.analyzeObservation(
      observation(STARTRACK_BAND, elevated, 105),
      STARTRACK_BAND,
      { referenceBaseline: reference, requireReferenceBaseline: true },
    );
    expect(secondVote).toMatchObject({ candidate: { hits: 2 }, alertEligible: false });
  });

  it("[trace:HW-008] fingerprints every detector rule and the exact receiver identity", () => {
    const original = fingerprint("target-rules");
    const { schemaVersion: _schemaVersion, detectorVersion: _detectorVersion, ...fingerprintInput } = original;
    const changedRules = {
      ...original,
      detectionRuleHash: detectionRuleFingerprint({ ...DEFAULT_THRESHOLDS, driftSigma: DEFAULT_THRESHOLDS.driftSigma + 1 }),
    };
    const changedReceiver = { ...original, receiverIdentity: "serial:RSPDX-OTHER" };
    const changedAntenna = { ...original, activeAntenna: "Antenna B" };
    expect(baselineFingerprintId(changedRules)).not.toBe(baselineFingerprintId(original));
    expect(baselineFingerprintId(changedReceiver)).not.toBe(baselineFingerprintId(original));
    expect(baselineFingerprintId(changedAntenna)).not.toBe(baselineFingerprintId(original));

    const engine = new DetectionEngine();
    const sample = observation(STARTRACK_BAND, new Uint8Array(BIN_COUNT).fill(30), 1);
    sample.fingerprint = { ...sample.fingerprint, detectionRuleHash: changedRules.detectionRuleHash };
    expect(engine.analyzeObservation(sample, STARTRACK_BAND)).toMatchObject({
      disposition: "unknown",
      unknownReason: "observation-ineligible",
      trainingEligible: false,
    });
    expect(() => createBaselineFingerprint({
      ...fingerprintInput,
      receiverIdentity: "",
    })).toThrow(/receiver identity/);
    expect(() => createBaselineFingerprint({
      ...fingerprintInput,
      detectionRuleHash: "not-a-hash",
    })).toThrow(/detector-rule hash/);
  });
});

describe("bounded robust detector", () => {
  it("[trace:CLAIM-007] quarantines an early RF rise instead of teaching it into a learning baseline", () => {
    const engine = new DetectionEngine();
    const quiet = new Uint8Array(BIN_COUNT).fill(30);
    const elevated = new Uint8Array(BIN_COUNT).fill(96);

    for (let index = 0; index < 8; index += 1) {
      const seed = engine.analyzeObservation(observation(STARTRACK_BAND, quiet, index), STARTRACK_BAND);
      expect(seed).toMatchObject({ disposition: "unknown", trainingEligible: false });
    }
    expect(engine.getBaselineStates()[0].observationCount).toBe(8);

    for (let index = 8; index < 24; index += 1) {
      const quarantined = engine.analyzeObservation(observation(STARTRACK_BAND, elevated, index), STARTRACK_BAND);
      expect(quarantined).toMatchObject({ disposition: "unknown", trainingEligible: false });
    }
    expect(engine.getBaselineStates()[0]).toMatchObject({ lifecycle: "learning", observationCount: 8 });

    const recovered = engine.analyzeObservation(observation(STARTRACK_BAND, quiet, 24), STARTRACK_BAND);
    expect(recovered).toMatchObject({ disposition: "unknown", trainingEligible: true });
    expect(engine.getBaselineStates()[0].observationCount).toBe(9);
  });

  it("keeps quiet quantized observations clear with a one-bin scale floor", () => {
    const engine = new DetectionEngine();
    train(engine);
    const result = engine.analyzeObservation(observation(STARTRACK_BAND, new Uint8Array(BIN_COUNT).fill(31), 70), STARTRACK_BAND);
    expect(result.disposition).toBe("clean");
    expect(result.event).toBeUndefined();
    expect(result.metrics.medianRobustZ).toBe(1);
  });

  it("requires repeated wideband exposure and never emits High RF-only evidence", () => {
    const engine = new DetectionEngine();
    train(engine);
    const elevated = new Uint8Array(BIN_COUNT).fill(96);
    const first = engine.analyzeObservation(observation(STARTRACK_BAND, elevated, 70), STARTRACK_BAND);
    const second = engine.analyzeObservation(observation(STARTRACK_BAND, elevated, 71), STARTRACK_BAND);
    const third = engine.analyzeObservation(observation(STARTRACK_BAND, elevated, 72), STARTRACK_BAND);
    expect(first).toMatchObject({ candidate: { kind: "wideband-noise-rise", hits: 1 }, alertEligible: false });
    expect(second.event).toBeUndefined();
    expect(third.event).toMatchObject({ kind: "wideband-noise-rise", evidenceStrength: "Low" });
    expect(third.event?.evidenceStrength).not.toBe("High");
  });

  it("classifies a narrow occupied segment as moving narrowband energy", () => {
    const engine = new DetectionEngine();
    train(engine);
    const bins = new Uint8Array(BIN_COUNT).fill(30);
    bins[31] = 220;
    let result;
    for (let index = 0; index < 3; index += 1) {
      result = engine.analyzeObservation(observation(STARTRACK_BAND, bins, 80 + index), STARTRACK_BAND);
    }
    expect(result?.event?.kind).toBe("narrowband-spike");
    expect(result?.event?.observed).toContain("narrowband energy");
    expect(result?.event?.observed.toLowerCase()).not.toContain("chirp");
  });

  it("trains on a pending non-alerting candidate only when learning accepts candidates", () => {
    const engine = new DetectionEngine();
    train(engine);
    const bins = new Uint8Array(BIN_COUNT).fill(30);
    bins[31] = 220;
    const rejected = engine.analyzeObservation(observation(STARTRACK_BAND, bins, 80), STARTRACK_BAND);
    expect(rejected).toMatchObject({ candidate: { kind: "narrowband-spike" }, alertEligible: false, trainingEligible: false });
    const accepted = engine.analyzeObservation(observation(STARTRACK_BAND, bins, 81), STARTRACK_BAND, { acceptCandidates: true });
    expect(accepted).toMatchObject({ candidate: { kind: "narrowband-spike" }, alertEligible: false, trainingEligible: true });
    const alerting = engine.analyzeObservation(observation(STARTRACK_BAND, bins, 82), STARTRACK_BAND, { acceptCandidates: true });
    expect(alerting.event?.kind).toBe("narrowband-spike");
    expect(alerting.trainingEligible).toBe(false);
  });

  it("requires accumulated observed exposure for slow drift", () => {
    const engine = new DetectionEngine();
    const drifted = new Uint8Array(BIN_COUNT).fill(35);
    const sample = observation(STARTRACK_BAND, drifted, 90, 4_000);
    const id = baselineFingerprintId(sample.fingerprint);
    const reference = {
      descriptor: {
        dataDomain: "test" as const,
        targetId: sample.targetId,
        lifecycle: "protected" as const,
        fingerprintId: id,
        baselineId: `${id}:7`,
        learningGenerationId: "7",
        observationCount: 256,
        validCoverageRatio: 1,
        representativeHours: 24,
        learningStartedAt: new Date(0).toISOString(),
        protectedAt: new Date(24 * 60 * 60_000).toISOString(),
      },
      medians: new Uint8Array(BIN_COUNT).fill(30),
      mads: new Uint8Array(BIN_COUNT),
    };
    const first = engine.analyzeObservation(sample, STARTRACK_BAND, { referenceBaseline: reference });
    const second = engine.analyzeObservation(observation(STARTRACK_BAND, drifted, 91, 4_000), STARTRACK_BAND, { referenceBaseline: reference });
    const third = engine.analyzeObservation(observation(STARTRACK_BAND, drifted, 92, 4_000), STARTRACK_BAND, { referenceBaseline: reference });
    expect(first.event).toBeUndefined();
    expect(second.event).toBeUndefined();
    expect(third.event).toMatchObject({ kind: "baseline-drift", status: "suspicious" });
  });

  it("does not call an unapproved learning reference slow drift", () => {
    const engine = new DetectionEngine();
    train(engine);
    const result = engine.analyzeObservation(
      observation(STARTRACK_BAND, new Uint8Array(BIN_COUNT).fill(35), 95, 12_000),
      STARTRACK_BAND,
    );
    expect(result.event).toBeUndefined();
    expect(result.candidate).toBeUndefined();
  });

  it("does not classify matched-power GNSS spectrum as spoofing", () => {
    const gnss = GNSS_BANDS.find((band) => band.id === "gps-l1")!;
    const engine = new DetectionEngine();
    train(engine, gnss);
    const result = engine.analyzeObservation(observation(gnss, new Uint8Array(BIN_COUNT).fill(30), 100), gnss);
    expect(result.disposition).toBe("clean");
    expect(result.event).toBeUndefined();
    const elevated = new Uint8Array(BIN_COUNT).fill(100);
    engine.analyzeObservation(observation(gnss, elevated, 101), gnss);
    engine.analyzeObservation(observation(gnss, elevated, 102), gnss);
    const anomaly = engine.analyzeObservation(observation(gnss, elevated, 103), gnss);
    expect(anomaly.event?.kind).toBe("gnss-energy-anomaly");
    expect(anomaly.event?.observed).toContain("RF data can show interference, not intent");
    expect(anomaly.event?.observed.toLowerCase()).not.toContain("spoof");
  });

  it("[trace:PROD-003] treats overload as unusable RF evidence and raises an operational incident", () => {
    const engine = new DetectionEngine();
    train(engine);
    const overloaded = observation(STARTRACK_BAND, new Uint8Array(BIN_COUNT).fill(30), 110);
    overloaded.overload = true;
    const result = engine.analyzeObservation(overloaded, STARTRACK_BAND, { freezeTraining: true });
    expect(result.disposition).toBe("anomalous");
    expect(result.alertEligible).toBe(true);
    expect(result.event).toMatchObject({ kind: "overload", status: "suspicious", evidenceStrength: "Low" });
    expect(result.analysis).toMatchObject({ overload: true, anomalyBinRanges: [] });
    expect(result.analysis.anomalyKind).toBeUndefined();
  });

  it("uses an exact persisted protected baseline immediately after detector restart", () => {
    const engine = new DetectionEngine();
    const targetId = STARTRACK_BAND.captureTargetId ?? `target-${STARTRACK_BAND.id}`;
    const id = "a".repeat(64);
    const reference = {
      descriptor: {
        dataDomain: "test" as const,
        targetId,
        lifecycle: "protected" as const,
        fingerprintId: id,
        baselineId: `${id}:4`,
        learningGenerationId: "4",
        observationCount: 256,
        validCoverageRatio: 1,
        representativeHours: 24,
        learningStartedAt: new Date(0).toISOString(),
        protectedAt: new Date(24 * 60 * 60_000).toISOString(),
      },
      medians: new Uint8Array(BIN_COUNT).fill(30),
      mads: new Uint8Array(BIN_COUNT),
    };
    const elevated = new Uint8Array(BIN_COUNT).fill(96);
    let result;
    for (let index = 0; index < 3; index += 1) {
      const input = observation(STARTRACK_BAND, elevated, 200 + index);
      reference.descriptor.fingerprintId = baselineFingerprintId(input.fingerprint);
      reference.descriptor.baselineId = `${reference.descriptor.fingerprintId}:4`;
      result = engine.analyzeObservation(input, STARTRACK_BAND, { referenceBaseline: reference });
    }
    expect(result?.event).toMatchObject({ evidenceStrength: "Medium", baselineId: reference.descriptor.baselineId });
    expect(result?.baseline.lifecycle).toBe("protected");
  });
});
