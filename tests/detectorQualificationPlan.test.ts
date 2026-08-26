import { describe, expect, it } from "vitest";
import {
  DETECTOR_QUALIFICATION_PLAN_VERSION,
  detectorQualificationPlan,
} from "../src/shared/detectorQualification";
import {
  createRandomizedSyntheticScenario,
  detectorQualificationTrialSeed,
  sha256Canonical,
} from "../src/server/syntheticValidation";
import { TEST_CATALOG } from "./catalogFixture";

describe("frozen detector qualification plan", () => {
  it("[trace:DET-210] [trace:PROD-002] defines deterministic, randomized, replay and installed-chain levels for every Tier-1 target", () => {
    const plan = detectorQualificationPlan(TEST_CATALOG);
    expect(plan.version).toBe(DETECTOR_QUALIFICATION_PLAN_VERSION);
    expect(plan.targets.map((target) => target.id)).toEqual([
      "gnss-l1-e1-b1c-sbas",
      "gnss-gps-l2c",
      "gnss-l5-e5a-b2a",
      "gnss-glonass-g1",
    ]);
    expect(plan.scenarios.map((scenario) => scenario.level)).toEqual([
      "isolated-deterministic",
      "isolated-randomized",
      "held-out-replay",
      "installed-chain",
    ]);
    expect(plan.scenarios.every((scenario) => scenario.targetIds.length === 4)).toBe(true);
    expect(plan.scenarios.every((scenario) => scenario.truthProtocol === "pre-run-sha256-commitment")).toBe(true);
    expect(plan.targets.map((target) => target.id)).toEqual(TEST_CATALOG.captureTargets
      .filter((target) => target.service === "gnss" && target.tier === "tier1" && target.defaultEnabled)
      .map((target) => target.id));
    expect(plan.scenarios.find((scenario) => scenario.level === "isolated-randomized")).toMatchObject({
      minimumIndependentRunsPerTargetFamily: 400,
      seedProtocol: "sha256(plan-version:target:family:trial-index)",
    });
  });

  it("keeps installed-chain qualification external and physically required", () => {
    const plan = detectorQualificationPlan(TEST_CATALOG);
    const installed = plan.scenarios.find((scenario) => scenario.level === "installed-chain")!;
    expect(plan.physicalQualificationRequired).toBe(true);
    expect(installed.inputDomain).toBe("installed-rf-chain");
    expect(installed.families).toEqual(expect.arrayContaining(["guard-bin-energy", "overload", "sham"]));
    expect(installed.externalPrerequisites.join(" ")).toMatch(/Calibrated conducted-RF equipment/);
    expect(plan.limitations.join(" ").toLowerCase()).toMatch(/cannot classify spoofing/);
  });

  it("returns an isolated clone with a reproducible canonical hash", () => {
    const first = detectorQualificationPlan(TEST_CATALOG);
    const hash = sha256Canonical(first);
    first.targets[0].centerHz = 1;
    const second = detectorQualificationPlan(TEST_CATALOG);
    expect(second.targets[0].centerHz).toBe(1_575_420_000);
    expect(sha256Canonical(second)).toBe(hash);
  });

  it("derives reproducible independent randomized trials inside the frozen envelope", () => {
    const seed = detectorQualificationTrialSeed(TEST_CATALOG, "gnss-gps-l2c", "wideband", 17);
    expect(seed).toMatch(/^[a-f0-9]{64}$/);
    expect(detectorQualificationTrialSeed(TEST_CATALOG, "gnss-gps-l2c", "wideband", 17)).toBe(seed);
    expect(detectorQualificationTrialSeed(TEST_CATALOG, "gnss-gps-l2c", "wideband", 18)).not.toBe(seed);

    const first = createRandomizedSyntheticScenario({ catalog: TEST_CATALOG, targetId: "gnss-gps-l2c", family: "wideband", trialIndex: 17 });
    const second = createRandomizedSyntheticScenario({ catalog: TEST_CATALOG, targetId: "gnss-gps-l2c", family: "wideband", trialIndex: 17 });
    const next = createRandomizedSyntheticScenario({ catalog: TEST_CATALOG, targetId: "gnss-gps-l2c", family: "wideband", trialIndex: 18 });
    expect(first).toEqual(second);
    expect(first).not.toEqual(next);
    expect(first.seed).toBe(seed);
    expect(first.targets[0]).toMatchObject({ id: "gnss-gps-l2c" });
    expect(first.events[0]).toMatchObject({ kind: "wideband", targetId: "gnss-gps-l2c" });
    if (first.events[0].kind === "wideband") {
      expect(first.events[0].amplitudeBins).toBeGreaterThanOrEqual(48);
      expect(first.events[0].amplitudeBins).toBeLessThanOrEqual(96);
      expect(first.events[0].occupancyRatio).toBeGreaterThanOrEqual(0.6);
      expect(first.events[0].occupancyRatio).toBeLessThanOrEqual(0.9);
    }
    expect(() => detectorQualificationTrialSeed(TEST_CATALOG, "not-a-target", "wideband", 0)).toThrow(/Unknown qualification target/);
  });
});
