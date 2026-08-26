import { describe, expect, it } from "vitest";
import {
  evaluateV3BrowserFacts,
  evaluateV3HealthPollingWindow,
  type V3BrowserQaFacts,
  type V3BrowserQaPathCounters,
} from "../src/client/v3BrowserHarness";

function counters(overrides: Partial<V3BrowserQaPathCounters> = {}): V3BrowserQaPathCounters {
  return {
    started: 0,
    completed: 0,
    aborted: 0,
    failed: 0,
    active: 0,
    maxConcurrent: 0,
    ...overrides,
  };
}

function facts(overrides: Partial<V3BrowserQaFacts> = {}): V3BrowserQaFacts {
  return {
    route: "/?qa=v3",
    surface: "dashboard",
    rootFound: true,
    meaningfulTextLength: 500,
    viewportWidth: 1_366,
    viewportHeight: 768,
    documentClientWidth: 1_366,
    documentScrollWidth: 1_366,
    frameworkOverlay: false,
    dataMode: "test",
    modeLabel: "Simulation / Test",
    monitoringState: "normal",
    monitoringLabel: "Normal",
    connectionError: false,
    dialogCount: 0,
    dialogHasAccessibleName: true,
    focusInsideTopDialog: true,
    protectedConfirmationPresent: false,
    protectedActionButtonPresent: false,
    protectedConfirmationMatches: false,
    protectedActionSafelyDisabled: true,
    protectedRetentionCopyPresent: true,
    helpTaskIds: [],
    helpHasVersion: false,
    externalResourceCount: 0,
    ...overrides,
  };
}

describe("V3 packaged browser evidence harness", () => {
  it("accepts bounded visible and hidden diagnostics polling windows", () => {
    expect(evaluateV3HealthPollingWindow(12_000, "visible", "active", counters({
      started: 7,
      completed: 7,
      maxConcurrent: 1,
    }))).toEqual([]);
    expect(evaluateV3HealthPollingWindow(24_000, "hidden", "active", counters({
      started: 3,
      completed: 3,
      maxConcurrent: 1,
    }))).toEqual([]);
    expect(evaluateV3HealthPollingWindow(12_000, "visible", "stopped", counters())).toEqual([]);
  });

  it("fails duplicate polling loops, overlap growth, failures, and requests after unmount", () => {
    expect(evaluateV3HealthPollingWindow(12_000, "visible", "active", counters({
      started: 20,
      completed: 19,
      failed: 1,
      maxConcurrent: 4,
    })).map((issue) => issue.code)).toEqual([
      "health-polling-rate-growth",
      "health-polling-concurrency",
      "health-polling-failed",
    ]);
    expect(evaluateV3HealthPollingWindow(12_000, "visible", "stopped", counters({
      started: 1,
      completed: 1,
      maxConcurrent: 1,
    })).map((issue) => issue.code)).toEqual(["health-polling-after-unmount"]);
  });

  it("detects overflow, stale Normal, and a missing Simulation/Test label", () => {
    expect(evaluateV3BrowserFacts(facts({
      documentScrollWidth: 1_390,
      connectionError: true,
      monitoringState: "data-late",
      dataMode: "test",
      modeLabel: "Field",
    })).map((issue) => issue.code)).toEqual([
      "horizontal-overflow",
      "test-mode-not-visible",
      "stale-normal",
    ]);
  });

  it("accepts a field dashboard without the removed Data footer chip and rejects a test label", () => {
    expect(evaluateV3BrowserFacts(facts({
      dataMode: "field",
      modeLabel: "RSPdx — Normal",
    }))).toEqual([]);
    expect(evaluateV3BrowserFacts(facts({
      dataMode: "field",
      modeLabel: "Simulation — GPS L1",
    })).map((issue) => issue.code)).toEqual(["field-mode-mislabeled"]);
  });

  it("fails closed when a protected action is enabled early or hides retained data", () => {
    expect(evaluateV3BrowserFacts(facts({
      dialogCount: 1,
      dialogHasAccessibleName: true,
      focusInsideTopDialog: true,
      protectedConfirmationPresent: true,
      protectedActionButtonPresent: true,
      protectedConfirmationMatches: false,
      protectedActionSafelyDisabled: false,
      protectedRetentionCopyPresent: false,
    })).map((issue) => issue.code)).toEqual([
      "protected-action-enabled-without-confirmation",
      "protected-action-scope-missing",
    ]);
  });

  it("allows a matching protected phrase to remain disabled for another safety reason", () => {
    expect(evaluateV3BrowserFacts(facts({
      protectedConfirmationPresent: true,
      protectedActionButtonPresent: true,
      protectedConfirmationMatches: true,
      protectedActionSafelyDisabled: true,
      protectedRetentionCopyPresent: true,
    }))).toEqual([]);
  });

  it("fails a protected confirmation with no guarded action button", () => {
    expect(evaluateV3BrowserFacts(facts({
      protectedConfirmationPresent: true,
      protectedActionButtonPresent: false,
      protectedConfirmationMatches: false,
      protectedActionSafelyDisabled: true,
      protectedRetentionCopyPresent: true,
    })).map((issue) => issue.code)).toEqual(["protected-action-button-missing"]);
  });

  it("requires all offline task topics, release identity, and same-origin resources on Help", () => {
    expect(evaluateV3BrowserFacts(facts({
      surface: "help",
      dataMode: "field",
      modeLabel: "Field",
      helpTaskIds: ["alert", "data", "recording"],
      helpHasVersion: false,
      externalResourceCount: 1,
    })).map((issue) => issue.code)).toEqual([
      "help-task-missing",
      "help-version-missing",
      "help-external-resource",
    ]);
    expect(evaluateV3BrowserFacts(facts({
      surface: "help",
      dataMode: "field",
      modeLabel: "Field",
      helpTaskIds: ["alert", "data", "recording", "learning", "test"],
      helpHasVersion: true,
    }))).toEqual([]);
  });
});
