import { describe, expect, it } from "vitest";
import {
  SyntheticValidationRun,
  binomialWilsonOneSidedInterval,
  binomialWilsonInterval,
  canonicalJson,
  createResearchSyntheticScenarioSuite,
  createSyntheticArtifactHashes,
  isSha256,
  scoreSyntheticValidationRun,
  sha256Canonical,
  summarizeIndependentValidationRuns,
  validateSyntheticScenario,
  verifySyntheticTruthDisclosure,
} from "../src/server/syntheticValidation";
import type {
  SyntheticArtifactInputs,
  SyntheticScenarioDefinition,
  SyntheticScenarioEvent,
  SyntheticTargetDefinition,
  ValidationObservationWindow,
  ValidationObservedAlert,
} from "../src/shared/syntheticValidation";

const TARGET: SyntheticTargetDefinition = {
  id: "gnss-l1",
  binCount: 128,
  baselineLevel: 30,
  noiseAmplitudeBins: 1,
  rippleAmplitudeBins: 1,
};

const ARTIFACTS: SyntheticArtifactInputs = {
  softwareBuild: { revision: "test-build" },
  configuration: { profile: "fast-gnss", revision: 3 },
  ruleSet: { id: "rf-relative-mad-v1" },
  baseline: { fingerprint: "test-only", generation: 1 },
};

function scenario(events: SyntheticScenarioEvent[], seed = "fixed-seed"): SyntheticScenarioDefinition {
  return {
    schemaVersion: 1,
    id: "scenario-test",
    version: "1.0.0",
    name: "Test scenario",
    seed,
    durationMs: 30_000,
    nominalFrameIntervalMs: 250,
    targets: [TARGET],
    events,
  };
}

function interval(id: string, kind: "wideband" | "sham" | "matched-power-spoofing" | "data-gap", start: number, end: number): SyntheticScenarioEvent {
  const common = { id, kind, targetId: TARGET.id, startMonotonicMs: start, endMonotonicMs: end } as const;
  if (kind === "wideband") return { ...common, kind, amplitudeBins: 70, occupancyRatio: 0.8, expected: { outcome: "alert" } };
  if (kind === "data-gap") return { ...common, kind, expected: { outcome: "unknown" } };
  return { ...common, kind, expected: { outcome: "no-alert" } };
}

function run(definition: SyntheticScenarioDefinition, mode: "guided" | "blinded" = "blinded", runId = "run-001") {
  return new SyntheticValidationRun({ scenario: definition, mode, runId, artifacts: ARTIFACTS });
}

function mean(bins: Uint8Array): number {
  return bins.reduce((total, value) => total + value, 0) / bins.length;
}

function maxIndex(bins: Uint8Array): number {
  let selected = 0;
  for (let index = 1; index < bins.length; index += 1) if (bins[index] > bins[selected]) selected = index;
  return selected;
}

describe("synthetic scenario schema and provenance", () => {
  it("provides the required research fixture families with bounded uint8 frames", () => {
    const suite = createResearchSyntheticScenarioSuite({ seedPrefix: "qualification", target: TARGET });
    expect(suite.map((entry) => entry.events[0].kind)).toEqual([
      "sham",
      "wideband",
      "pulsed-wideband",
      "cw",
      "multitone",
      "moving-narrowband",
      "overload",
      "configuration-change",
      "data-gap",
      "matched-power-spoofing",
    ]);
    for (const [index, definition] of suite.entries()) {
      const validationRun = run(definition, "blinded", `suite-${index}`);
      const frame = validationRun.frameAt(TARGET.id, 10_000);
      if (definition.events[0].kind === "data-gap") expect(frame).toBeUndefined();
      else {
        expect(frame).toBeInstanceOf(Uint8Array);
        expect(frame).toHaveLength(TARGET.binCount);
      }
    }
  });

  it("rejects scientifically invalid expected outcomes and out-of-range events", () => {
    expect(() => validateSyntheticScenario(scenario([{
      id: "bad-spoof",
      kind: "matched-power-spoofing",
      targetId: TARGET.id,
      startMonotonicMs: 1_000,
      endMonotonicMs: 2_000,
      expected: { outcome: "alert" },
    }]))).toThrow(/must expect no-alert/);
    expect(() => validateSyntheticScenario(scenario([{
      id: "bad-gap",
      kind: "data-gap",
      targetId: TARGET.id,
      startMonotonicMs: 29_000,
      endMonotonicMs: 31_000,
      expected: { outcome: "unknown" },
    }]))).toThrow(/invalid monotonic interval/);
  });

  it("canonicalizes inputs and records hashes for every qualification artifact", () => {
    expect(canonicalJson({ z: 2, a: { y: 1, x: 0 } })).toBe('{"a":{"x":0,"y":1},"z":2}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
    const hashes = createSyntheticArtifactHashes(ARTIFACTS);
    expect(Object.values(hashes).every(isSha256)).toBe(true);
    expect(new Set(Object.values(hashes)).size).toBe(4);
  });
});

describe("deterministic detector-facing FFT generation", () => {
  it("is deterministic by seed, target and global monotonic time, not call or tune order", () => {
    const definition = scenario([interval("wide", "wideband", 5_000, 15_000)]);
    const first = run(definition, "blinded", "run-a");
    const second = run(definition, "blinded", "run-b");
    const direct = first.frameAt(TARGET.id, 8_000)!;
    first.frameAt(TARGET.id, 1_000);
    first.frameAt(TARGET.id, 20_000);
    expect(first.frameAt(TARGET.id, 8_000)).toEqual(direct);
    expect(second.frameAt(TARGET.id, 8_000)).toEqual(direct);
    expect(run(scenario(definition.events, "other-seed")).frameAt(TARGET.id, 8_000)).not.toEqual(direct);

    const before = first.frameAt(TARGET.id, 4_000)!;
    const during = first.frameAt(TARGET.id, 8_000)!;
    const after = first.frameAt(TARGET.id, 16_000)!;
    expect(mean(during) - mean(before)).toBeGreaterThan(40);
    expect(Math.abs(mean(after) - mean(before))).toBeLessThan(3);
  });

  it("keeps shams and matched-power spoofing spectrally identical to the same seeded baseline", () => {
    const baseline = run(scenario([]));
    const sham = run(scenario([interval("sham", "sham", 5_000, 15_000)]));
    const matched = run(scenario([interval("matched", "matched-power-spoofing", 5_000, 15_000)]));
    const expected = baseline.frameAt(TARGET.id, 8_000);
    expect(sham.frameAt(TARGET.id, 8_000)).toEqual(expected);
    expect(matched.frameAt(TARGET.id, 8_000)).toEqual(expected);
  });

  it("renders pulsed, CW, multitone and moving relative-energy shapes", () => {
    const suite = createResearchSyntheticScenarioSuite({ seedPrefix: "shape", target: TARGET });
    const byKind = new Map(suite.map((entry) => [entry.events[0].kind, run(entry)]));

    const pulsed = byKind.get("pulsed-wideband")!;
    expect(mean(pulsed.frameAt(TARGET.id, 5_000)!) - mean(pulsed.frameAt(TARGET.id, 5_750)!)).toBeGreaterThan(40);

    const cw = byKind.get("cw")!.frameAt(TARGET.id, 8_000)!;
    expect(maxIndex(cw)).toBeGreaterThan(60);
    expect(maxIndex(cw)).toBeLessThan(68);

    const multitone = byKind.get("multitone")!.frameAt(TARGET.id, 8_000)!;
    expect(multitone.filter((value) => value > 100).length).toBeGreaterThanOrEqual(3);

    const moving = byKind.get("moving-narrowband")!;
    expect(Math.abs(maxIndex(moving.frameAt(TARGET.id, 6_000)!) - maxIndex(moving.frameAt(TARGET.id, 10_000)!))).toBeGreaterThan(10);
  });

  it("models data availability, overload and persistent configuration state without truth labels", () => {
    const suite = createResearchSyntheticScenarioSuite({ seedPrefix: "control", target: TARGET });
    const byKind = new Map(suite.map((entry) => [entry.events[0].kind, run(entry)]));
    const gap = byKind.get("data-gap")!;
    expect(gap.frameAt(TARGET.id, 8_000)).toBeUndefined();
    expect(gap.sensorStateAt(TARGET.id, 8_000)).toEqual({ dataAvailable: false, overload: false, configurationOffset: 0 });

    const overload = byKind.get("overload")!;
    expect(overload.sensorStateAt(TARGET.id, 8_000)).toEqual({ dataAvailable: true, overload: true, configurationOffset: 0 });
    expect(new Set(overload.frameAt(TARGET.id, 8_000))).toEqual(new Set([250]));

    const changed = byKind.get("configuration-change")!;
    expect(changed.sensorStateAt(TARGET.id, 4_000).configurationOffset).toBe(0);
    expect(changed.sensorStateAt(TARGET.id, 16_000).configurationOffset).toBe(1);
    expect(Object.keys(changed.sensorStateAt(TARGET.id, 8_000))).toEqual(["dataAvailable", "overload", "configurationOffset"]);
  });
});

describe("guided and blinded truth separation", () => {
  it("withholds scenario identity, seed and events from blinded operator metadata", () => {
    const definition = scenario([interval("wide-secret", "wideband", 5_000, 15_000)], "secret-seed");
    const blinded = run(definition, "blinded");
    const encoded = JSON.stringify(blinded.getMetadata());
    expect(encoded).not.toContain("scenario-test");
    expect(encoded).not.toContain("secret-seed");
    expect(encoded).not.toContain("wide-secret");
    expect(encoded).not.toContain("wideband");
    expect(blinded.getMetadata()).toMatchObject({ synthetic: true, mode: "blinded", truthCommitment: expect.any(String) });
    expect("truth" in blinded.getMetadata()).toBe(false);
    expect(blinded.getEvidenceMarker()).toEqual({
      schemaVersion: 1,
      synthetic: true,
      runId: "run-001",
      mode: "blinded",
      validationProtocolVersion: "rf-synthetic-validation-1",
      generatorVersion: "relative-fft-generator-1",
      truthCommitment: blinded.getMetadata().truthCommitment,
    });
  });

  it("shows truth in guided mode and verifies the post-run blinded disclosure commitment", () => {
    const definition = scenario([interval("wide", "wideband", 5_000, 15_000)]);
    const guided = run(definition, "guided", "guided-run");
    expect(guided.getMetadata()).toMatchObject({ synthetic: true, mode: "guided", truth: { scenario: { seed: "fixed-seed" } } });

    const blinded = run(definition, "blinded", "blind-run");
    const disclosure = blinded.discloseTruth();
    expect(verifySyntheticTruthDisclosure(blinded.getMetadata(), disclosure)).toBe(true);
    disclosure.scenario.seed = "tampered";
    expect(verifySyntheticTruthDisclosure(blinded.getMetadata(), disclosure)).toBe(false);
  });

  it("does not attach truth or scenario fields to detector-facing frames", () => {
    const validationRun = run(scenario([interval("wide", "wideband", 5_000, 15_000)]));
    const frame = validationRun.frameAt(TARGET.id, 8_000)!;
    expect(frame).toBeInstanceOf(Uint8Array);
    expect((frame as unknown as Record<string, unknown>).scenarioId).toBeUndefined();
    expect((frame as unknown as Record<string, unknown>).eventKind).toBeUndefined();
    expect((frame as unknown as Record<string, unknown>).truth).toBeUndefined();
  });
});

describe("offline run-level scoring", () => {
  const definition = scenario([
    interval("wide", "wideband", 2_000, 8_000),
    interval("matched", "matched-power-spoofing", 9_000, 13_000),
    interval("gap", "data-gap", 14_000, 17_000),
    interval("sham", "sham", 18_000, 22_000),
  ]);

  const observations: ValidationObservationWindow[] = [
    { targetId: TARGET.id, startMonotonicMs: 2_000, endMonotonicMs: 3_000, outcome: "valid" },
    { targetId: TARGET.id, startMonotonicMs: 3_000, endMonotonicMs: 5_000, outcome: "valid" },
    { targetId: TARGET.id, startMonotonicMs: 14_000, endMonotonicMs: 17_000, outcome: "unknown", reason: "data-gap" },
  ];

  it("scores detections, latency, merged observed exposure, negative controls and unknowns", () => {
    const validationRun = run(definition);
    const alerts: ValidationObservedAlert[] = [{
      id: "alert-wide",
      targetId: TARGET.id,
      startedMonotonicMs: 5_000,
      lastSeenMonotonicMs: 7_000,
    }];
    const score = validationRun.score(alerts, observations, 1_000);
    expect(score).toMatchObject({
      synthetic: true,
      expectedAlertEvents: 1,
      detectedExpectedEvents: 1,
      observableExpectedAlertEvents: 1,
      detectedObservableExpectedEvents: 1,
      expectedNoAlertEvents: 2,
      correctNonDetections: 2,
      expectedUnknownEvents: 1,
      observedUnknownEvents: 1,
      unexpectedAlerts: 0,
      detectionProbability: 1,
      conditionalDetectionProbability: 1,
      precision: 1,
      passed: true,
    });
    expect(score.eventScores.find((entry) => entry.eventId === "wide")).toMatchObject({
      verdict: "detected",
      wallClockLatencyMs: 3_000,
      observedExposureToAlertMs: 3_000,
      unobservedLatencyToAlertMs: 0,
    });
    expect(score).toMatchObject({
      scenarioId: "scenario-test",
      scenarioVersion: "1.0.0",
      scenarioSeed: "fixed-seed",
      truthCommitment: expect.stringMatching(/^[a-f0-9]{64}$/),
      perTarget: [expect.objectContaining({
        targetId: TARGET.id,
        detectedExpectedEvents: 1,
        missedExpectedEvents: 0,
        unexpectedAlerts: 0,
        wallClockLatency: expect.objectContaining({ samples: 1, p95Ms: 3_000 }),
      })],
    });
    expect(score.eventScores.find((entry) => entry.eventId === "matched")?.verdict).toBe("correct-non-detection");
  });

  it("counts end-to-end misses separately from conditional observed performance and false alerts", () => {
    const validationRun = run(definition);
    const falseAlert: ValidationObservedAlert = {
      id: "false-sham",
      targetId: TARGET.id,
      startedMonotonicMs: 19_000,
      clearedMonotonicMs: 20_500,
    };
    const score = validationRun.score([falseAlert], observations.filter((entry) => entry.outcome === "unknown"), 1_000);
    expect(score).toMatchObject({
      detectedExpectedEvents: 0,
      missedExpectedEvents: 1,
      observableExpectedAlertEvents: 0,
      unobservedExpectedAlertEvents: 1,
      conditionalDetectionProbability: null,
      unexpectedAlerts: 1,
      falseAlertDurationMs: 1_500,
      passed: false,
    });
    expect(score.falseAlertsPerTargetHour).toBeCloseTo(120);
  });

  it("rejects tampered ground truth before scoring", () => {
    const validationRun = run(definition);
    const truth = validationRun.discloseTruth();
    truth.scenario.durationMs += 1;
    expect(() => scoreSyntheticValidationRun({ truth, alerts: [], observations: [] })).toThrow(/hash does not match/);
  });

  it("rejects duplicate alert identities and invalid observation intervals", () => {
    const validationRun = run(definition);
    const duplicate: ValidationObservedAlert = { id: "same", targetId: TARGET.id, startedMonotonicMs: 4_000 };
    expect(() => validationRun.score([duplicate, duplicate], observations)).toThrow(/Duplicate alert id/);
    expect(() => validationRun.score([], [{
      targetId: TARGET.id,
      startMonotonicMs: 2_000,
      endMonotonicMs: 1_000,
      outcome: "valid",
    }])).toThrow(/invalid monotonic timestamps/);
  });

  it("computes confidence intervals across independent runs rather than frames", () => {
    const passing = run(definition).score([{
      id: "detected",
      targetId: TARGET.id,
      startedMonotonicMs: 5_000,
    }], observations, 1_000);
    const summary = summarizeIndependentValidationRuns(Array.from({ length: 30 }, () => structuredClone(passing)));
    expect(summary).toMatchObject({ synthetic: true, runCount: 30, detectionRunSuccesses: 30, detectionRunTrials: 30, allPassed: true });
    expect(summary.detectionRunInterval?.lower).toBeGreaterThan(0.88);
    expect(summary.detectionRunInterval?.lower).toBeLessThan(0.90);
    expect(summary.detectionRunInterval?.upper).toBe(1);
    expect(binomialWilsonInterval(0, 30).upper).toBeGreaterThan(0.11);
    expect(summary.perTargetAndFamily).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: TARGET.id,
        scenarioFamily: "wideband",
        detectionTrials: 30,
        detectionSuccesses: 30,
        detectionLower95: expect.objectContaining({ side: "one-sided", lower: expect.any(Number) }),
      }),
    ]));
    expect(binomialWilsonOneSidedInterval(400, 400).lower).toBeGreaterThan(0.99);
    expect(() => summarizeIndependentValidationRuns([])).toThrow(/At least one/);
  });

  it("separates observed exposure from latency while the tuner was elsewhere", () => {
    const validationRun = run(scenario([interval("wide", "wideband", 2_000, 8_000)]));
    const score = validationRun.score([{
      id: "late-alert",
      targetId: TARGET.id,
      startedMonotonicMs: 5_000,
    }], [{
      targetId: TARGET.id,
      startMonotonicMs: 2_000,
      endMonotonicMs: 3_000,
      outcome: "valid",
    }], 1_000);
    expect(score.eventScores[0]).toMatchObject({
      wallClockLatencyMs: 3_000,
      observedExposureToAlertMs: 1_000,
      unobservedLatencyToAlertMs: 2_000,
    });
    expect(score.perTarget[0].unobservedLatencyToAlert).toMatchObject({ samples: 1, p50Ms: 2_000 });
  });
});
