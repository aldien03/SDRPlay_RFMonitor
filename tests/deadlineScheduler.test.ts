import { describe, expect, it, vi } from "vitest";
import {
  DeadlineScheduler,
  type DeadlineTarget,
  type VisitRecord,
} from "../src/server/deadlineScheduler";

const TIER_ONE_TARGETS: DeadlineTarget[] = [
  {
    id: "gnss-l1-e1-b1c-sbas",
    tier: "tier1",
    revisitObjectiveMs: 2_000,
    nominalVisitMs: 1_000,
    maxVisitMs: 1_500,
    weight: 10,
  },
  {
    id: "gnss-gps-l2c",
    tier: "tier1",
    revisitObjectiveMs: 6_000,
    nominalVisitMs: 1_000,
    maxVisitMs: 1_500,
    weight: 10,
  },
  {
    id: "gnss-l5-e5a-b2a",
    tier: "tier1",
    revisitObjectiveMs: 6_000,
    nominalVisitMs: 1_000,
    maxVisitMs: 1_500,
    weight: 10,
  },
  {
    id: "gnss-glonass-g1",
    tier: "tier1",
    revisitObjectiveMs: 6_000,
    nominalVisitMs: 1_000,
    maxVisitMs: 1_500,
    weight: 10,
  },
];

const OPTIONAL_TARGET: DeadlineTarget = {
  id: "gnss-beidou-b1i",
  tier: "tier2",
  revisitObjectiveMs: 30_000,
  nominalVisitMs: 1_000,
  maxVisitMs: 1_500,
  weight: 1,
};

describe("DeadlineScheduler", () => {
  it("[trace:PROD-001] [trace:CLAIM-005] produces the nominal phased Tier-1 order with deterministic deadline ties", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler(TIER_ONE_TARGETS, {
      now: () => now,
      initialNowMs: 0,
      initialPhaseAnchorsMs: {
        "gnss-l1-e1-b1c-sbas": 0,
        "gnss-gps-l2c": -4_000,
        "gnss-l5-e5a-b2a": -2_000,
        "gnss-glonass-g1": 0,
      },
    });

    const selected: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const decision = scheduler.beginNext();
      expect(decision?.reason).toBe("tier1-least-laxity");
      selected.push(decision!.target.id);
      now += 1_000;
      scheduler.completeActive({ valid: true });
    }

    expect(selected).toEqual([
      "gnss-l1-e1-b1c-sbas",
      "gnss-gps-l2c",
      "gnss-l1-e1-b1c-sbas",
      "gnss-l5-e5a-b2a",
      "gnss-l1-e1-b1c-sbas",
      "gnss-glonass-g1",
    ]);
    expect(scheduler.getCompletionHistory().every((record) => !record.missedObjective)).toBe(true);
    const firstCompletionByTarget = new Map<string, VisitRecord>();
    for (const record of scheduler.getCompletionHistory()) {
      if (!firstCompletionByTarget.has(record.targetId)) firstCompletionByTarget.set(record.targetId, record);
    }
    expect([...firstCompletionByTarget.values()].every((record) => record.revisitMs === undefined)).toBe(true);
    expect(scheduler.snapshot().targets.reduce((total, target) => total + target.validRevisits, 0)).toBe(2);
  });

  it("advances a failed target's attempt cadence without starving healthy Tier-1 peers", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler(TIER_ONE_TARGETS, {
      now: () => now,
      initialNowMs: 0,
      initialPhaseAnchorsMs: {
        "gnss-l1-e1-b1c-sbas": 0,
        "gnss-gps-l2c": -4_000,
        "gnss-l5-e5a-b2a": -2_000,
        "gnss-glonass-g1": 0,
      },
    });
    const selected: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const decision = scheduler.beginNext()!;
      selected.push(decision.target.id);
      now += 1_000;
      const failed = decision.target.id === "gnss-l1-e1-b1c-sbas";
      scheduler.completeActive({
        valid: !failed,
        cause: failed ? "receiver-unhealthy" : "valid-observation",
      });
    }

    expect(selected).toEqual([
      "gnss-l1-e1-b1c-sbas",
      "gnss-gps-l2c",
      "gnss-l1-e1-b1c-sbas",
      "gnss-l5-e5a-b2a",
      "gnss-l1-e1-b1c-sbas",
      "gnss-glonass-g1",
    ]);
    const l1 = scheduler.snapshot().targets.find((target) => target.id === "gnss-l1-e1-b1c-sbas");
    expect(l1).toMatchObject({
      deadlineMs: 2_000,
      nextAttemptDeadlineMs: 7_000,
      retryNotBeforeMs: 6_000,
      failedVisits: 3,
      validCompletions: 0,
    });
  });

  it("gates an early failed retry for one nominal visit without advancing compliance", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 2_000,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_500,
      weight: 1,
    }], { now: () => now, initialNowMs: 0 });

    scheduler.beginNext();
    now = 100;
    scheduler.completeActive({ valid: false, cause: "tune-mismatch" });

    expect(scheduler.snapshot()).toMatchObject({
      targets: [{
        deadlineMs: 0,
        nextAttemptDeadlineMs: 2_100,
        retryNotBeforeMs: 1_100,
        failedVisits: 1,
      }],
    });
    expect(scheduler.beginNext()).toBeUndefined();
    expect(scheduler.nextSelectionAtMs()).toBe(1_100);
    now = 1_099;
    expect(scheduler.beginNext()).toBeUndefined();
    now = 1_100;
    expect(scheduler.beginNext()?.target.id).toBe("target");
  });

  it("measures recovery against the last valid completion after a failed attempt", () => {
    let now = 900;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });

    scheduler.beginNext();
    now = 1_000;
    scheduler.completeActive({ valid: false, cause: "insufficient-frames" });
    now = 1_100;
    const retry = scheduler.beginNext();
    expect(retry).toMatchObject({
      deadlineMs: 2_000,
      complianceDeadlineMs: 1_000,
      retryNotBeforeMs: 1_100,
    });
    now = 1_200;
    const recovered = scheduler.completeActive({ valid: true });

    expect(recovered).toMatchObject({
      previousValidCompletionMs: 0,
      revisitMs: 1_200,
      deadlineAtStartMs: 1_000,
      missedObjective: true,
      missByMs: 200,
    });
  });

  it("separates late valid revisits from late invalid attempt breaches", () => {
    let now = 1_000;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });

    scheduler.beginNext();
    now = 1_100;
    scheduler.completeActive({ valid: false, cause: "insufficient-frames" });
    now = 1_200;
    scheduler.beginNext();
    now = 1_300;
    scheduler.completeActive({ valid: true });

    expect(scheduler.snapshot().targets[0]).toMatchObject({
      revisitObjectiveMs: 1_000,
      validRevisits: 1,
      onTimeValidRevisits: 0,
      lateValidRevisits: 1,
      failedVisits: 1,
      missedRevisits: 2,
    });
  });

  it("uses the documented L1, L2, L5, G1 tie order when deadlines are equal", () => {
    let now = 0;
    const equalTargets = TIER_ONE_TARGETS.map((target) => ({
      ...target,
      revisitObjectiveMs: 10_000,
    }));
    const scheduler = new DeadlineScheduler(equalTargets, { now: () => now, initialNowMs: 0 });
    const selected: string[] = [];

    for (let index = 0; index < equalTargets.length; index += 1) {
      selected.push(scheduler.beginNext()!.target.id);
      now += 100;
      scheduler.completeActive({ valid: true });
    }

    expect(selected).toEqual(TIER_ONE_TARGETS.map((target) => target.id));
  });

  it("measures revisit completion-to-completion and unobserved gap separately", () => {
    let now = 900;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });

    scheduler.beginNext();
    now = 1_000;
    const failed = scheduler.completeActive({ valid: false, cause: "tune-timeout" });
    expect(failed.actualUnobservedGapMs).toBeUndefined();
    expect(failed.revisitMs).toBeUndefined();
    expect(failed.completionCause).toBe("tune-timeout");

    now = 1_100;
    scheduler.beginNext();
    now = 1_200;
    const recovered = scheduler.completeActive({
      valid: true,
      firstObservedAtMs: 1_150,
      lastObservedAtMs: 1_190,
      observedExposureMs: 40,
    });
    expect(recovered.previousValidCompletionMs).toBe(0);
    expect(recovered.actualUnobservedGapMs).toBe(1_150);
    expect(recovered.revisitMs).toBe(1_200);
    expect(recovered.missedObjective).toBe(true);
    expect(recovered.missByMs).toBe(200);
    expect(recovered.missCause).toBe("revisit-objective-missed");
  });

  it("[trace:CLAIM-006] measures the unobserved gap between actual exposure boundaries", () => {
    let now = 900;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 2_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });
    scheduler.beginNext();
    now = 1_000;
    const record = scheduler.completeActive({
      valid: true,
      firstObservedAtMs: 950,
      lastObservedAtMs: 990,
      observedExposureMs: 40,
    });
    expect(record).toMatchObject({
      revisitMs: 1_000,
      actualUnobservedGapMs: 950,
      firstObservedAtMs: 950,
      lastObservedAtMs: 990,
      observedExposureMs: 40,
    });
  });

  it("preserves real exposure from an incomplete visit without treating it as a valid revisit", () => {
    let now = 900;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 2_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });

    scheduler.beginNext();
    now = 1_000;
    const incomplete = scheduler.completeActive({
      valid: false,
      cause: "insufficient-frames",
      firstObservedAtMs: 950,
      lastObservedAtMs: 980,
      observedExposureMs: 30,
    });
    expect(incomplete).toMatchObject({
      valid: false,
      revisitMs: undefined,
      actualUnobservedGapMs: 950,
      observedExposureMs: 30,
    });
    expect(scheduler.snapshot().targets[0]).toMatchObject({
      lastValidCompletionMs: 0,
      currentUnobservedGapMs: 20,
      validRevisits: 0,
      failedVisits: 1,
    });

    now = 1_100;
    scheduler.beginNext();
    now = 1_200;
    const valid = scheduler.completeActive({
      valid: true,
      firstObservedAtMs: 1_150,
      lastObservedAtMs: 1_190,
      observedExposureMs: 40,
    });
    expect(valid).toMatchObject({
      revisitMs: 1_200,
      actualUnobservedGapMs: 170,
    });
  });

  it.each([
    "tune-timeout",
    "tune-mismatch",
    "insufficient-frames",
    "receiver-unhealthy",
    "configuration-changed",
  ])("keeps the fault cause on an overdue Unknown visit: %s", (cause) => {
    let now = 900;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
    });
    scheduler.beginNext();
    now = 1_100;
    const record = scheduler.completeActive({ valid: false, cause });
    expect(record).toMatchObject({
      valid: false,
      completionCause: cause,
      revisitMs: undefined,
      actualUnobservedGapMs: undefined,
      missedObjective: true,
      missByMs: 100,
      missCause: cause,
    });
  });

  it("[trace:HW-007] admits no optional work when the default Tier-1 schedule consumes 100% capacity", () => {
    const scheduler = new DeadlineScheduler([...TIER_ONE_TARGETS, OPTIONAL_TARGET], {
      initialNowMs: 0,
      now: () => 0,
      initialPhaseAnchorsMs: Object.fromEntries(TIER_ONE_TARGETS.map((target) => [target.id, 0])),
      optionalQualificationMs: 0,
      minimumTierOneValidRevisitsForOptional: 0,
    });

    expect(scheduler.snapshot().tierOneUtilization).toBeCloseTo(1, 10);
    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({
      allowed: false,
      reason: "protected-reserve-unavailable",
    });
    expect(scheduler.beginNext()!.target.tier).toBe("tier1");
  });

  it("requires live look-ahead in addition to the static reserve", () => {
    let now = 7_000;
    const scheduler = new DeadlineScheduler([{
      id: "slow-tier1",
      tier: "tier1",
      revisitObjectiveMs: 10_000,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_500,
      weight: 1,
    }, OPTIONAL_TARGET], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { "slow-tier1": 0 },
      optionalQualificationMs: 0,
      minimumTierOneValidRevisitsForOptional: 0,
    });

    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({ allowed: true, reason: "admitted" });
    now = 8_000;
    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({
      allowed: false,
      reason: "tier1-look-ahead-failed",
    });
  });

  it("can disable the commissioning gate for a migrated legacy profile without disabling live look-ahead", () => {
    let now = 9_000;
    const scheduler = new DeadlineScheduler([{
      id: "legacy-priority",
      tier: "tier1",
      revisitObjectiveMs: 10_000,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_000,
      weight: 10,
    }, OPTIONAL_TARGET], {
      now: () => now,
      initialNowMs: 0,
      initialValidCompletions: { "legacy-priority": 0 },
      enforceOptionalQualification: false,
    });
    scheduler.beginNext();
    now = 10_000;
    scheduler.completeActive({ valid: false, cause: "tune-timeout" });
    scheduler.beginNext();
    now = 11_000;
    scheduler.completeActive({ valid: true });

    expect(scheduler.snapshot().targets.find((target) => target.id === "legacy-priority")?.failedVisits).toBe(1);
    expect(scheduler.snapshot().optionalQualificationReady).toBe(true);
    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({ allowed: true, reason: "admitted" });
  });

  it("keeps optional work paused until the Tier-1 qualification window and accuracy are met", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler([{
      id: "slow-tier1",
      tier: "tier1",
      revisitObjectiveMs: 10_000,
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 1,
    }, { ...OPTIONAL_TARGET, nominalVisitMs: 100, maxVisitMs: 100 }], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { "slow-tier1": 0 },
      optionalQualificationMs: 1_000,
      minimumTierOneValidRevisitsForOptional: 1,
    });

    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({
      allowed: false,
      reason: "tier1-not-qualified",
    });
    now = 100;
    scheduler.beginNext();
    now = 200;
    scheduler.completeActive({ valid: true });
    now = 1_000;
    expect(scheduler.snapshot()).toMatchObject({
      optionalQualificationReady: true,
      optionalQualificationElapsedMs: 1_000,
    });
    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id).allowed).toBe(true);
  });

  it("does not qualify optional work after an unknown or currently overdue Tier-1 visit", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler([{
      id: "slow-tier1",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 1,
    }, { ...OPTIONAL_TARGET, nominalVisitMs: 50, maxVisitMs: 50 }], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { "slow-tier1": 0 },
      optionalQualificationMs: 100,
      minimumTierOneValidRevisitsForOptional: 0,
    });
    scheduler.beginNext();
    now = 100;
    scheduler.completeActive({ valid: false, cause: "receiver-unhealthy" });
    expect(scheduler.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({ allowed: false, reason: "tier1-not-qualified" });

    const overdue = new DeadlineScheduler([{
      id: "slow-tier1",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 1,
    }, { ...OPTIONAL_TARGET, nominalVisitMs: 50, maxVisitMs: 50 }], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { "slow-tier1": 0 },
      optionalQualificationMs: 0,
      minimumTierOneValidRevisitsForOptional: 0,
    });
    now = 1_001;
    expect(overdue.canAdmitOptional(OPTIONAL_TARGET.id)).toEqual({ allowed: false, reason: "tier1-not-qualified" });
  });

  it("uses bounded weighted deficit scheduling for optional targets", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler([{
      ...OPTIONAL_TARGET,
      id: "heavy-survey",
      tier: "survey",
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 2,
    }, {
      ...OPTIONAL_TARGET,
      id: "light-survey",
      tier: "survey",
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 1,
    }], { initialNowMs: 0, now: () => now });
    const selected: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const decision = scheduler.beginNext();
      expect(decision?.reason).toBe("optional-weighted-deficit");
      selected.push(decision!.target.id);
      now += 100;
      scheduler.completeActive({ valid: true });
    }

    expect(selected.filter((id) => id === "heavy-survey")).toHaveLength(4);
    expect(selected.filter((id) => id === "light-survey")).toHaveLength(2);
  });

  it("allows visit extension only when Tier-1 look-ahead remains feasible", () => {
    const saturated = new DeadlineScheduler(TIER_ONE_TARGETS, {
      initialNowMs: 0,
      now: () => 0,
      initialPhaseAnchorsMs: {
        "gnss-l1-e1-b1c-sbas": 0,
        "gnss-gps-l2c": -4_000,
        "gnss-l5-e5a-b2a": -2_000,
        "gnss-glonass-g1": 0,
      },
    });
    saturated.beginNext();
    expect(saturated.canExtendActive(1_500)).toEqual({
      allowed: false,
      reason: "tier1-look-ahead-failed",
    });

    const slack = new DeadlineScheduler([{
      id: "gnss-l1-e1-b1c-sbas",
      tier: "tier1",
      revisitObjectiveMs: 5_000,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_500,
      weight: 1,
    }, {
      id: "gnss-glonass-g1",
      tier: "tier1",
      revisitObjectiveMs: 10_000,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_500,
      weight: 1,
    }], {
      initialNowMs: 0,
      now: () => 0,
      initialPhaseAnchorsMs: {
        "gnss-l1-e1-b1c-sbas": 0,
        "gnss-glonass-g1": 0,
      },
    });
    slack.beginNext();
    expect(slack.canExtendActive(1_500)).toEqual({ allowed: true, reason: "extension-safe" });
    expect(slack.canExtendActive(1_501)).toEqual({
      allowed: false,
      reason: "above-maximum-budget",
    });
  });

  it("bounds extension against elapsed time, the active objective, and the configured maximum", () => {
    let now = 950;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    }], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { target: 0 },
    });
    expect(scheduler.canExtendActive(100)).toEqual({ allowed: false, reason: "no-visit-in-progress" });
    scheduler.beginNext();
    expect(scheduler.canExtendActive(100)).toEqual({ allowed: true, reason: "within-nominal-budget" });
    expect(scheduler.canExtendActive(150)).toEqual({ allowed: false, reason: "active-deadline-would-be-missed" });
    expect(scheduler.canExtendActive(151)).toEqual({ allowed: false, reason: "above-maximum-budget" });
    now = 1_051;
    expect(scheduler.canExtendActive(100)).toEqual({ allowed: false, reason: "below-elapsed-time" });
  });

  it("keeps real restored completions and schedule-only phase anchors mutually exclusive", () => {
    const target = {
      id: "target",
      tier: "tier1" as const,
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 150,
      weight: 1,
    };
    expect(() => new DeadlineScheduler([target], {
      initialNowMs: 0,
      initialValidCompletions: { target: 0 },
      initialPhaseAnchorsMs: { target: 0 },
    })).toThrow(/both an initial valid completion and an initial phase anchor/);
    expect(() => new DeadlineScheduler([target], {
      initialNowMs: 0,
      initialPhaseAnchorsMs: { target: 1 },
    })).toThrow(/phase anchor cannot be later/);
  });

  it("bounds completion and miss histories and rejects backward time", () => {
    let now = 200;
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 100,
      nominalVisitMs: 10,
      maxVisitMs: 10,
      weight: 1,
    }], {
      initialNowMs: 0,
      now: () => now,
      initialValidCompletions: { target: 0 },
      historyLimit: 2,
    });

    for (let index = 0; index < 5; index += 1) {
      scheduler.beginNext();
      now += 10;
      scheduler.completeActive({ valid: true, cause: `completion-${index}` });
      now += 190;
    }

    expect(scheduler.getCompletionHistory().map((record) => record.sequence)).toEqual([4, 5]);
    expect(scheduler.getMissHistory().map((record) => record.sequence)).toEqual([4, 5]);
    expect(scheduler.snapshot().targets[0]).toMatchObject({ validCompletions: 5, validRevisits: 5, missedRevisits: 5 });
    expect(() => scheduler.snapshot(now - 1)).toThrow(/moved backwards/);
  });

  it("is unaffected by forward or backward wall-clock jumps", () => {
    let monotonicNow = 100;
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
    const scheduler = new DeadlineScheduler([{
      id: "target",
      tier: "tier1",
      revisitObjectiveMs: 1_000,
      nominalVisitMs: 100,
      maxVisitMs: 100,
      weight: 1,
    }], { initialNowMs: 0, now: () => monotonicNow });

    expect(scheduler.snapshot().atMs).toBe(100);
    wallClock.mockReturnValue(1);
    monotonicNow = 200;
    expect(scheduler.snapshot().atMs).toBe(200);
    wallClock.mockRestore();
  });

  it("[trace:SCH-110] runs the exact saturated Tier-1 pattern for 24 monotonic hours without cadence drift", () => {
    let now = 0;
    const scheduler = new DeadlineScheduler(TIER_ONE_TARGETS, {
      initialNowMs: now,
      now: () => now,
      initialPhaseAnchorsMs: {
        "gnss-l1-e1-b1c-sbas": 0,
        "gnss-gps-l2c": -4_000,
        "gnss-l5-e5a-b2a": -2_000,
        "gnss-glonass-g1": 0,
      },
    });
    const completions = new Map<string, number>();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);

    for (let visit = 0; visit < 86_400; visit += 1) {
      const decision = scheduler.beginNext();
      expect(decision).toBeDefined();
      completions.set(decision!.target.id, (completions.get(decision!.target.id) ?? 0) + 1);
      const startedAt = now;
      now += 1_000;
      if (visit === 43_200) wallClock.mockReturnValue(1);
      scheduler.completeActive({
        valid: true,
        firstObservedAtMs: startedAt + 250,
        lastObservedAtMs: startedAt + 750,
        observedExposureMs: 500,
      });
    }
    wallClock.mockRestore();

    expect(now).toBe(24 * 60 * 60_000);
    expect(Object.fromEntries(completions)).toEqual({
      "gnss-l1-e1-b1c-sbas": 43_200,
      "gnss-gps-l2c": 14_400,
      "gnss-l5-e5a-b2a": 14_400,
      "gnss-glonass-g1": 14_400,
    });
    const snapshot = scheduler.snapshot();
    expect(snapshot.targets.reduce((total, target) => total + target.validRevisits, 0)).toBe(86_396);
    expect(snapshot.targets.every((target) => target.onTimeRatio === 1 && target.missedRevisits === 0)).toBe(true);
    expect(scheduler.getMissHistory()).toHaveLength(0);
    expect(scheduler.getCompletionHistory()).toHaveLength(256);
  });
});
