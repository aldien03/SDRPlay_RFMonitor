import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  parseSyntheticScenarios,
  parseSyntheticValidationResult,
  getSyntheticVerdict,
  SyntheticValidationPanel,
} from "../src/client/SyntheticValidationPanel";

describe("synthetic validation panel", () => {
  it("accepts only versioned synthetic scenario lists and removes duplicates", () => {
    expect(parseSyntheticScenarios({
      schemaVersion: 1,
      synthetic: true,
      scenarios: [
        { id: "wideband", name: "Wideband rise", expectedOutcome: "alert", target: { label: "GPS L1", centerHz: 1_575_420_000 } },
        { id: "wideband", name: "Duplicate", expectedOutcome: "unknown" },
        { id: "gap", name: "Data gap" },
        { id: "", name: "Invalid", expectedOutcome: "alert" },
      ],
    })).toEqual([
      { id: "wideband", name: "Wideband rise", expectedOutcome: "alert", targetLabel: "GPS L1", targetCenterHz: 1_575_420_000 },
      { id: "gap", name: "Data gap", expectedOutcome: "Not specified" },
    ]);
    expect(parseSyntheticScenarios({ schemaVersion: 2, synthetic: true, scenarios: [] })).toEqual([]);
    expect(parseSyntheticScenarios({ schemaVersion: 1, synthetic: false, scenarios: [] })).toEqual([]);
  });

  it("reads nested reports and tolerates missing optional fields", () => {
    expect(parseSyntheticValidationResult({
      synthetic: true,
      report: {
        pass: true,
        scenarioName: "Wideband rise",
        scenarioId: "wideband",
        observedOutcome: "alert",
        expectedOutcome: "alert",
        target: { label: "GPS L1 / Galileo E1", centerHz: 1_575_420_000 },
        runId: "run-1",
      },
    })).toEqual({
      pass: true,
      scenarioName: "Wideband rise",
      scenarioId: "wideband",
      observedOutcome: "alert",
      expectedOutcome: "alert",
      targetLabel: "GPS L1 / Galileo E1",
      targetCenterHz: 1_575_420_000,
      runId: "run-1",
      synthetic: true,
    });
    expect(parseSyntheticValidationResult({
      schemaVersion: 1,
      synthetic: true,
      passed: false,
      runId: "run-2",
      scenario: { id: "moving-narrowband", name: "Moving narrowband", expectedOutcome: "alert" },
      observed: { outcome: "no-alert" },
    })).toMatchObject({
      pass: false,
      scenarioId: "moving-narrowband",
      scenarioName: "Moving narrowband",
      observedOutcome: "no-alert",
      expectedOutcome: "alert",
      runId: "run-2",
      synthetic: true,
    });
    expect(parseSyntheticValidationResult({ report: {} })).toEqual({
      pass: undefined,
      scenarioId: undefined,
      scenarioName: undefined,
      observedOutcome: undefined,
      expectedOutcome: undefined,
      targetLabel: undefined,
      targetCenterHz: undefined,
      synthetic: undefined,
      runId: undefined,
    });
  });

  it("maps detector outcomes to plain operational verdicts", () => {
    expect(getSyntheticVerdict({ scenarioId: "wideband", observedOutcome: "alert", expectedOutcome: "alert", pass: true })).toMatchObject({
      label: "Suspected RF interference",
      tone: "interference",
    });
    expect(getSyntheticVerdict({ scenarioId: "overload", observedOutcome: "alert", expectedOutcome: "alert", pass: true })).toMatchObject({
      label: "Receiver overloaded",
      tone: "receiver",
    });
    expect(getSyntheticVerdict({ scenarioId: "sham", observedOutcome: "no-alert", expectedOutcome: "no-alert", pass: true })).toMatchObject({
      label: "No RF anomaly",
      tone: "normal",
    });
    expect(getSyntheticVerdict({ scenarioId: "data-gap", observedOutcome: "unknown", expectedOutcome: "unknown", pass: true })).toMatchObject({
      label: "Test inconclusive",
      tone: "unknown",
    });
    expect(getSyntheticVerdict({ scenarioId: "wideband", observedOutcome: "no-alert", expectedOutcome: "alert", pass: false })).toMatchObject({
      label: "Interference not detected",
      tone: "interference",
    });
    expect(getSyntheticVerdict({ scenarioId: "sham", observedOutcome: "alert", expectedOutcome: "no-alert", pass: false })).toMatchObject({
      label: "Unexpected RF alert",
      tone: "interference",
    });
    expect(getSyntheticVerdict({ scenarioId: "wideband", observedOutcome: undefined, expectedOutcome: "alert", pass: false })).toMatchObject({
      label: "Result unavailable",
      tone: "neutral",
    });
    expect(getSyntheticVerdict({ scenarioId: "matched-power-spoofing", observedOutcome: "no-alert", expectedOutcome: "no-alert", pass: true })).toMatchObject({
      label: "No RF change detected",
      tone: "neutral",
    });
    expect(getSyntheticVerdict({ scenarioId: "data-gap", observedOutcome: "no-alert", expectedOutcome: "unknown", pass: false })).toMatchObject({
      label: "Unexpected clear result",
      tone: "interference",
    });
    expect(getSyntheticVerdict({ scenarioId: "wideband", observedOutcome: "no-alert", expectedOutcome: "alert", pass: true })).toMatchObject({
      label: "Result inconsistent",
      tone: "interference",
    });
  });

  it.each([
    ["sham", "no-alert", "No RF anomaly", "normal"],
    ["wideband", "alert", "Suspected RF interference", "interference"],
    ["pulsed-wideband", "alert", "Suspected RF interference", "interference"],
    ["cw", "alert", "Suspected RF interference", "interference"],
    ["multitone", "alert", "Suspected RF interference", "interference"],
    ["moving-narrowband", "alert", "Suspected RF interference", "interference"],
    ["overload", "alert", "Receiver overloaded", "receiver"],
    ["configuration-change", "unknown", "Test inconclusive", "unknown"],
    ["data-gap", "unknown", "Test inconclusive", "unknown"],
    ["matched-power-spoofing", "no-alert", "No RF change detected", "neutral"],
  ])("maps expected-pass scenario %s to %s", (scenarioId, observedOutcome, label, tone) => {
    expect(getSyntheticVerdict({
      scenarioId,
      observedOutcome,
      expectedOutcome: observedOutcome,
      pass: true,
    })).toMatchObject({ label, tone });
  });

  it.each([
    ["wideband", "unknown", "alert", "Test inconclusive"],
    ["data-gap", "alert", "unknown", "Unexpected RF alert"],
    ["data-gap", "no-alert", "unknown", "Unexpected clear result"],
    ["sham", "alert", "no-alert", "Unexpected RF alert"],
    ["wideband", "no-alert", "alert", "Interference not detected"],
  ])("fails closed for mismatched scenario %s", (scenarioId, observedOutcome, expectedOutcome, label) => {
    expect(getSyntheticVerdict({ scenarioId, observedOutcome, expectedOutcome, pass: false })).toMatchObject({
      label,
      tone: label === "Test inconclusive" ? "unknown" : "interference",
    });
  });

  it("renders a compact accessible test control", () => {
    const markup = renderToStaticMarkup(createElement(SyntheticValidationPanel, {
      fetcher: (() => Promise.reject(new Error("not called during server render"))) as typeof fetch,
    }));
    expect(markup).toContain("Test RF Monitor");
    expect(markup).toContain("Simulation only");
    expect(markup).toContain('aria-label="Synthetic test scenario"');
    expect(markup).toContain('type="radio"');
    expect(markup).toContain("Guided");
    expect(markup).toContain("Blinded");
    expect(markup).toContain("Detector check");
    expect(markup).toContain("Run detector check");
  });
});
