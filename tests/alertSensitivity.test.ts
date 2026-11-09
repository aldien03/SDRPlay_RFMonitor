import { describe, expect, it } from "vitest";
import {
  baselineFingerprintId,
  createBaselineFingerprint,
  DEFAULT_THRESHOLDS,
  detectionRuleFingerprint,
  DetectionEngine,
  withAlertPolicyHash,
  type DetectionBaselineReference,
  type ResolvedAlertPolicyWithHash,
} from "../src/shared/detection";
import {
  alertPresetValues,
  alertVoteGapMs,
  classifyAlert,
  createAlertTrackerState,
  deriveAlertingFromDetection,
  describeAlertPolicy,
  mergeHzRanges,
  segmentFeatures,
  updateAlertTracker,
} from "../src/shared/alertPolicy";
import { rfOnlyDetectionClaimBlockers, rfVerdictFor } from "../src/shared/productContract";
import { GNSS_BANDS, STARTRACK_BAND } from "./catalogFixture";
import type { AlertPresetId, BandPreset, BaselineLifecycle, TargetObservation } from "../src/shared/types";

const BIN_COUNT = 200;

function policy(id: AlertPresetId): ResolvedAlertPolicyWithHash {
  return withAlertPolicyHash({ choice: id, source: "default", values: alertPresetValues(id) });
}

function observation(band: BandPreset, bins: Uint8Array, sequence: number, exposureMs = 500, spacingMs = 1_000): TargetObservation {
  const targetId = band.captureTargetId ?? `target-${band.id}`;
  const observedAtMs = 10_000_000 + sequence * spacingMs;
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
    centerHz: band.captureCenterHz ?? band.centerHz,
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
    observedAt: new Date(observedAtMs).toISOString(),
    firstFrameAt: new Date(observedAtMs - exposureMs).toISOString(),
    lastFrameAt: new Date(observedAtMs).toISOString(),
    exposureMs,
    acceptedFrameCount: 3,
    bins,
    confirmedCenterHz: fingerprint.centerHz,
    confirmedSampleRateHz: 10_000_000,
    tuneConfirmedAt: new Date(observedAtMs - exposureMs - 250).toISOString(),
    fingerprint,
    overload: false,
    healthComplete: true,
  };
}

function reference(sample: TargetObservation, lifecycle: BaselineLifecycle = "provisional"): DetectionBaselineReference {
  const id = baselineFingerprintId(sample.fingerprint);
  return {
    descriptor: {
      dataDomain: "test",
      targetId: sample.targetId,
      lifecycle,
      fingerprintId: id,
      ...(lifecycle === "protected" ? { baselineId: `${id}:3`, protectedAt: new Date(0).toISOString() } : {}),
      learningGenerationId: "3",
      observationCount: 256,
      validCoverageRatio: 1,
      representativeHours: lifecycle === "protected" ? 24 : 0,
      learningStartedAt: new Date(0).toISOString(),
    },
    medians: new Uint8Array(sample.bins.length).fill(30),
    mads: new Uint8Array(sample.bins.length).fill(2),
  };
}

/** Quiet 30 with MAD 2: one normal variation is 2.97 units. */
function withSegment(start: number, end: number, level: number, base: Uint8Array = new Uint8Array(BIN_COUNT).fill(30)): Uint8Array {
  const bins = Uint8Array.from(base);
  for (let index = start; index < end; index += 1) bins[index] = level;
  return bins;
}

function run(engine: DetectionEngine, bins: Uint8Array[], options: { band?: BandPreset; preset?: AlertPresetId; lifecycle?: BaselineLifecycle; exposureMs?: number; spacingMs?: number; voteGapMs?: number; frames?: (index: number) => Uint8Array[] | undefined; start?: number } = {}) {
  const band = options.band ?? STARTRACK_BAND;
  return bins.map((value, index) => {
    const sample = observation(band, value, (options.start ?? 0) + index, options.exposureMs, options.spacingMs);
    return engine.analyzeObservation(sample, band, {
      referenceBaseline: reference(sample, options.lifecycle),
      requireReferenceBaseline: true,
      alertPolicy: policy(options.preset ?? "standard"),
      voteGapMs: options.voteGapMs,
      frameBins: options.frames?.(index),
      shadowPreview: true,
    });
  });
}

describe("alert sensitivity is independent of signal learning", () => {
  it("keeps the learning-rule fingerprint byte-for-byte so learned baselines stay valid", () => {
    expect(detectionRuleFingerprint(DEFAULT_THRESHOLDS)).toBe("9f528fa28f1b5db56accc94c036e472e91067b9cbfe48b09a015b6e7000fe668");
  });

  it("produces identical training decisions under every alert preset", () => {
    const stream = [
      ...Array.from({ length: 4 }, () => new Uint8Array(BIN_COUNT).fill(30)),
      ...Array.from({ length: 4 }, () => withSegment(60, 100, 80)),
      ...Array.from({ length: 3 }, () => withSegment(10, 12, 70)),
      ...Array.from({ length: 4 }, () => new Uint8Array(BIN_COUNT).fill(42)),
      ...Array.from({ length: 3 }, () => new Uint8Array(BIN_COUNT).fill(30)),
    ];
    const decisions = (preset: AlertPresetId) => run(new DetectionEngine(), stream, { preset }).map((result) => result.trainingEligible);
    const conservative = decisions("conservative");
    expect(decisions("very-sensitive")).toEqual(conservative);
    expect(decisions("standard")).toEqual(conservative);
  });
});

describe("segment-based alert classifier", () => {
  it("[S1] raises a partial-band alert for a 20%-wide emission the old rules never classified", () => {
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(60, 100, 80)));
    expect(results[0]).toMatchObject({ disposition: "anomalous", candidate: { detailKind: "partial-band", hits: 1 }, alertEligible: false });
    const event = results[2].event!;
    expect(event).toMatchObject({ kind: "wideband-noise-rise", detailKind: "partial-band", evidenceStrength: "Low", status: "interference-likely" });
    // 40 of 200 bins across the 10 MHz test capture.
    const [start, end] = event.disturbedRangesHz![0];
    expect(end - start).toBe(2_000_000);
    expect(event.trigger?.rules.find((rule) => rule.rule === "partial-band")).toMatchObject({ met: true, threshold: 6 });
    expect(event.observed).toMatch(/Raised RF energy over 2\.0 MHz/);
    expect(results[2].analysis.anomalyBinRanges).toEqual([{ startBin: 60, endBin: 100 }]);
    expect(results[2].analysis).toMatchObject({ anomalyKind: "wideband-noise-rise", anomalyDetailKind: "partial-band" });
  });

  it.each([
    [0.05, 70, "narrowband"],
    [0.3, 60, "partial-band"],
    [0.4, 60, "wideband"],
    [0.8, 60, "wideband"],
  ] as const)("classifies a %s-wide raised region as %s", (ratio, level, expected) => {
    const width = Math.round(ratio * BIN_COUNT);
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(10, 10 + width, level)));
    expect(results[2].event?.detailKind).toBe(expected);
  });

  it("stays quiet just below the raised level and alerts just above it", () => {
    // Scale 2.97: 6x is 17.8 units above usual.
    expect(run(new DetectionEngine(), Array.from({ length: 5 }, () => withSegment(40, 120, 30 + 17))).some((result) => result.candidate)).toBe(false);
    expect(run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(40, 120, 30 + 19)))[2].event?.detailKind).toBe("wideband");
  });

  it("still finds a narrow signal next to a wider segment and draws both", () => {
    const bins = withSegment(150, 152, 90, withSegment(20, 60, 80));
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => bins));
    expect(results[2].event?.detailKind).toBe("partial-band");
    expect(results[2].analysis.anomalyBinRanges).toEqual([{ startBin: 20, endBin: 60 }, { startBin: 150, endBin: 152 }]);
  });

  it("joins a wide emission whose bins dip briefly below the line", () => {
    const bins = withSegment(40, 120, 80);
    bins[80] = 30;
    const features = segmentFeatures(Array.from(bins, (value) => (value - 30) / 2.9652), BIN_COUNT, 6, 0.005, 0);
    expect(features.segments).toHaveLength(1);
  });

  it("[S4] counts mixed raised kinds together and reports the most severe", () => {
    const results = run(new DetectionEngine(), [withSegment(10, 12, 90), withSegment(40, 100, 80), withSegment(40, 100, 80)]);
    expect(results[2].event?.detailKind).toBe("partial-band");
  });

  it("[S4] alerts after three ~500 ms checks instead of needing four", () => {
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(0, 200, 80)), { exposureMs: 500 });
    expect(results[2].event?.detailKind).toBe("wideband");
  });

  it("[S4] keeps votes across slow revisits when the gap follows the revisit objective", () => {
    const bins = Array.from({ length: 3 }, () => withSegment(40, 100, 80));
    expect(run(new DetectionEngine(), bins, { spacingMs: 40_000 }).some((result) => result.event)).toBe(false);
    expect(run(new DetectionEngine(), bins, { spacingMs: 40_000, voteGapMs: alertVoteGapMs(18_000) })[2].event?.detailKind).toBe("partial-band");
  });

  it("[S2] flags a noise-floor rise against a provisional local reference as Low evidence", () => {
    const raised = Array.from({ length: 21 }, () => new Uint8Array(BIN_COUNT).fill(30 + 13));
    const results = run(new DetectionEngine(), raised, { exposureMs: 500 });
    const alert = results.find((result) => result.event);
    expect(alert?.event).toMatchObject({ kind: "baseline-drift", detailKind: "noise-floor", evidenceStrength: "Low", status: "suspicious" });
    expect(alert?.event?.observed).toContain("local reference");
    expect(alert?.event?.observed).not.toContain("approved");
    expect(run(new DetectionEngine(), raised, { preset: "conservative" }).some((result) => result.event)).toBe(false);
  });

  it("says approved baseline only for a protected reference", () => {
    const raised = Array.from({ length: 21 }, () => new Uint8Array(BIN_COUNT).fill(30 + 13));
    const alert = run(new DetectionEngine(), raised, { lifecycle: "protected" }).find((result) => result.event);
    expect(alert?.event).toMatchObject({ detailKind: "noise-floor", evidenceStrength: "Medium" });
    expect(alert?.event?.observed).toContain("approved baseline");
  });

  it("never raises alerts while the persistent reference is still learning", () => {
    const results = run(new DetectionEngine(), Array.from({ length: 5 }, () => withSegment(40, 100, 80)), { lifecycle: "learning" });
    expect(results.every((result) => result.disposition === "unknown" && !result.event)).toBe(true);
  });

  it("[S3] catches short bursts in single frames only when burst detection is on, without training on them", () => {
    const quiet = new Uint8Array(BIN_COUNT).fill(30);
    const burstFrame = withSegment(50, 110, 90);
    const frames = () => [quiet, burstFrame, quiet];
    const standard = run(new DetectionEngine(), Array.from({ length: 4 }, () => quiet), { frames });
    expect(standard.some((result) => result.candidate)).toBe(false);
    const sensitive = run(new DetectionEngine(), Array.from({ length: 4 }, () => quiet), { frames, preset: "sensitive" });
    expect(sensitive[0].candidate).toMatchObject({ detailKind: "burst" });
    expect(sensitive[1].event).toMatchObject({ detailKind: "burst", status: "suspicious" });
    expect(sensitive.map((result) => result.trainingEligible)).toEqual(standard.map((result) => result.trainingEligible));
  });

  it("keeps the GNSS public kind while recording the specific rule", () => {
    const gnss = GNSS_BANDS.find((band) => band.id === "gps-l1")!;
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(99, 101, 90)), { band: gnss });
    const event = results[2].event!;
    expect(event).toMatchObject({ kind: "gnss-energy-anomaly", detailKind: "narrowband" });
    expect(rfVerdictFor(event)).toBe("Suspected RF interference");
    expect(event.observed).toContain("RF data can show interference, not intent");
    expect(rfOnlyDetectionClaimBlockers(event as never)).toEqual([]);
  });

  it("resets pending votes when the alert policy changes", () => {
    const engine = new DetectionEngine();
    const bins = withSegment(40, 100, 80);
    run(engine, [bins, bins], { preset: "standard" });
    const after = run(engine, [bins], { preset: "conservative", start: 2 });
    expect(after[0].candidate?.hits).toBe(1);
  });

  it("records a complete, bounded trigger and a lossless hex snapshot", () => {
    const results = run(new DetectionEngine(), Array.from({ length: 3 }, () => withSegment(60, 100, 80)));
    const result = results[2];
    const trigger = result.event!.trigger!;
    expect(trigger).toMatchObject({
      schemaVersion: 1,
      classifierVersion: "rf-alert-segments-1",
      detailKind: "partial-band",
      policy: { choice: "standard", values: alertPresetValues("standard") },
      reference: { lifecycle: "provisional", kind: "local" },
      persistence: { votes: 3, required: 3, window: 5 },
    });
    expect(trigger.rules.length).toBeLessThanOrEqual(6);
    expect(trigger.measured.levelAboveUsual).toBe(50);
    expect(trigger.measured.peakFrequencyHz).toBeGreaterThan(trigger.analyzedRangeHz[0]);
    const snapshot = result.triggerSnapshot!("event-1");
    expect(snapshot).toMatchObject({ eventId: "event-1", binCount: BIN_COUNT, reduction: "native", anomalyBinRanges: [{ startBin: 60, endBin: 100 }] });
    expect(snapshot.levelsHex).toHaveLength(BIN_COUNT * 2);
    expect(Buffer.from(snapshot.levelsHex, "hex")[70]).toBe(80);
    expect(Buffer.from(snapshot.usualHex, "hex")[70]).toBe(30);
    expect(Buffer.from(snapshot.alertLevelHex, "hex")[70]).toBe(Math.round(30 + 6 * 1.4826 * 2));
  });

  it("exposes Engineer gauge margins for every rule", () => {
    const [result] = run(new DetectionEngine(), [withSegment(60, 100, 80)]);
    expect(result.gauge?.rules.map((rule) => rule.rule)).toEqual(["wideband", "partial-band", "narrowband", "noise-floor", "persistence"]);
    expect(result.gauge).toMatchObject({ votes: 1, required: 3, preset: "standard" });
  });

  it("estimates how many alerts each preset would have raised", () => {
    const engine = new DetectionEngine();
    const stream = [
      ...Array.from({ length: 3 }, () => withSegment(60, 100, 50)),
      ...Array.from({ length: 6 }, () => new Uint8Array(BIN_COUNT).fill(30)),
    ];
    run(engine, stream, { preset: "standard" });
    const preview = engine.getAlertPreview(observation(STARTRACK_BAND, stream[0], 0).targetId, 10_000_000 + 20_000)!;
    // +20 units = 6.7x: Sensitive/Very sensitive raise it, Conservative does not.
    expect(preview.onsets.conservative).toBe(0);
    expect(preview.onsets.sensitive).toBe(1);
    expect(preview.onsets["very-sensitive"]).toBe(1);
    expect(preview.onsets.standard).toBe(preview.activeOnsets);
  });
});

describe("alert policy helpers", () => {
  it("derives Standard from default learning rules", () => {
    expect(deriveAlertingFromDetection(DEFAULT_THRESHOLDS, DEFAULT_THRESHOLDS).default.preset).toBe("standard");
  });

  it("describes a policy in short plain facts", () => {
    const facts = describeAlertPolicy(alertPresetValues("standard"), 8_000_000);
    expect(facts.find((fact) => fact.id === "partial-band")?.text).toBe("Wider than 0.8 MHz at 6×");
    expect(facts.find((fact) => fact.id === "persistence")?.text).toBe("3 of 5 checks, 1 s observed");
    expect(facts.find((fact) => fact.id === "burst")?.text).toBe("Off");
  });

  it("requires the current check to be raised and resets after a long gap", () => {
    const values = alertPresetValues("standard");
    const state = createAlertTrackerState("h");
    const step = (atMs: number, emission?: "wideband") => updateAlertTracker(state, { atMs, emission, floor: false, exposureMs: 500, values, voteGapMs: 30_000, policyHash: "h" });
    step(0, "wideband");
    step(1_000, "wideband");
    expect(step(2_000).alertKind).toBeUndefined();
    expect(step(3_000, "wideband")).toMatchObject({ alertKind: "wideband", onset: true });
    expect(step(4_000, "wideband").onset).toBe(false);
    expect(step(60_000, "wideband").votes).toBe(1);
  });

  it("classifies with explicit rule comparisons", () => {
    const z = Array.from({ length: 100 }, (_, index) => (index < 40 ? 12 : 0));
    const result = classifyAlert(segmentFeatures(z, 100, 6, 0, 0), alertPresetValues("standard"), { floorMedianZ: 0, floorAllowed: true });
    expect(result.emission).toBe("wideband");
    expect(result.rules[0]).toMatchObject({ rule: "wideband", measured: 0.4, met: true });
  });

  it("merges and caps disturbed ranges", () => {
    expect(mergeHzRanges([[10, 20], [15, 30], [40, 50]])).toEqual([[10, 30], [40, 50]]);
    expect(mergeHzRanges(Array.from({ length: 30 }, (_, index): [number, number] => [index * 10, index * 10 + 5]), 16)).toHaveLength(16);
  });
});
