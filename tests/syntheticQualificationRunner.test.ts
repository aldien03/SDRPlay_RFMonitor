import { describe, expect, it } from "vitest";
import {
  listSyntheticQualificationScenarios,
  runSyntheticQualificationScenario,
} from "../src/server/syntheticQualificationRunner";
import { TEST_CATALOG } from "./catalogFixture";

const runScenario = (scenarioId: string, mode: "guided" | "blinded") => runSyntheticQualificationScenario(
  scenarioId,
  mode,
  { bandCatalog: TEST_CATALOG },
);

describe("isolated synthetic qualification runner", () => {
  it("runs every bounded research fixture through the real detector", () => {
    const scenarios = listSyntheticQualificationScenarios(TEST_CATALOG);
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
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
    expect(scenarios.every((scenario) => scenario.target.id === "gnss-l1-e1-b1c-sbas")).toBe(true);
    expect(scenarios.every((scenario) => scenario.target.centerHz === 1_575_420_000)).toBe(true);
    expect(scenarios[0].target.label).toContain("GPS L1");
    for (const scenario of scenarios) {
      const report = runScenario(scenario.id, "blinded");
      expect(report).toMatchObject({
        schemaVersion: 1,
        synthetic: true,
        source: "isolated-simulation",
        mode: "blinded",
        qualification: { level: "isolated-deterministic", installedChain: "not-run" },
        detector: { implementation: "DetectionEngine", ruleSetId: "rf-relative-mad-v1" },
        truth: { disclosedAfterRun: true, verified: true },
        score: { synthetic: true },
      });
      expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(64 * 1024);
      expect(Object.values(report.provenance).filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))).toHaveLength(5);
      expect(report.passed).toBe(true);
    }
  });

  it("detects the wideband fixture after repeated observed exposure", () => {
    const report = runScenario("wideband", "guided");
    expect(report.observed).toMatchObject({ outcome: "alert", alertKinds: ["gnss-energy-anomaly"] });
    expect(report.score.eventScores).toEqual([
      expect.objectContaining({ kind: "wideband", expectedOutcome: "alert", verdict: "detected" }),
    ]);
    expect(report.score.eventScores[0].observedExposureToAlertMs).toBeGreaterThanOrEqual(2_000);
    expect(report.truth).toMatchObject({ disclosedAfterRun: false, verified: true });
    expect(report.passed).toBe(true);
  });

  it("keeps matched-power spoofing as a correct RF-spectrum non-detection", () => {
    const report = runScenario("matched-power-spoofing", "blinded");
    expect(report.observed).toEqual({
      outcome: "no-alert",
      alertKinds: [],
      validObservations: 20,
      unknownObservations: 0,
      receiverOverload: false,
      rfAnomalyAlert: false,
    });
    expect(report.score.eventScores).toEqual([
      expect.objectContaining({
        kind: "matched-power-spoofing",
        expectedOutcome: "no-alert",
        verdict: "correct-non-detection",
      }),
    ]);
    expect(report.passed).toBe(true);
  });

  it("records data gaps as unknown rather than clean", () => {
    const report = runScenario("data-gap", "guided");
    expect(report.observed.outcome).toBe("unknown");
    expect(report.observed.unknownObservations).toBeGreaterThan(0);
    expect(report.score.eventScores[0]).toMatchObject({ expectedOutcome: "unknown", verdict: "unknown-observed" });
    expect(report.passed).toBe(true);
  });

  it("reports overload as a receiver condition rather than RF interference", () => {
    const report = runScenario("overload", "blinded");
    expect(report.observed).toMatchObject({
      outcome: "alert",
      alertKinds: ["overload"],
      receiverOverload: true,
      rfAnomalyAlert: false,
    });
    expect(report.score.perTarget[0]).toMatchObject({ targetId: "gnss-l1-e1-b1c-sbas", detectedExpectedEvents: 1 });
  });

  it("detects moving narrowband energy that persists through visit aggregation", () => {
    const report = runScenario("moving-narrowband", "blinded");
    expect(report.observed.outcome).toBe("alert");
    expect(report.score.eventScores[0]).toMatchObject({ expectedOutcome: "alert", verdict: "detected" });
    expect(report.passed).toBe(true);
  });

  it("rejects unknown scenarios and modes", () => {
    expect(() => runScenario("not-a-scenario", "guided")).toThrow(/Unknown synthetic validation scenario/);
    expect(() => runSyntheticQualificationScenario("sham", "other" as "guided", { bandCatalog: TEST_CATALOG })).toThrow(/guided or blinded/);
  });
});
