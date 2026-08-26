import { describe, expect, it } from "vitest";
import {
  MAX_OPERATOR_AFFECTED_TARGETS,
  OPERATOR_ACTION_CODES,
  OPERATOR_ACTION_COPY,
  OPERATOR_REASON_CODES,
  OPERATOR_REASON_COPY,
  isOperatorSummary,
  presentOperatorSummary,
  resolveOperatorSummary,
  type OperatorMonitoringState,
  type OperatorSummaryInput,
} from "../src/shared/operatorSummary";

const NOW = "2026-08-23T12:00:00.000Z";
const OBSERVED_AT = "2026-08-23T11:59:58.000Z";

function input(overrides: Partial<OperatorSummaryInput> = {}): OperatorSummaryInput {
  const base: OperatorSummaryInput = {
    generatedAt: NOW,
    serverBuildId: "release-a",
    dataDomain: "field",
    monitoring: {
      receiverOnline: true,
      dataFresh: true,
      paused: false,
      alertActive: false,
      recovering: false,
      candidateActive: false,
      detectingActive: false,
      checking: false,
      since: "2026-08-23T11:00:00.000Z",
    },
    recording: { state: "recording" },
    currentHealth: { state: "normal" },
    productionQualification: {
      state: "qualified",
      ready: true,
      epochId: "qualification-a",
    },
    affectedTargets: [{ id: "gnss-l1", label: "GNSS L1", frequencyLabel: "1575.420 MHz" }],
    observation: { at: OBSERVED_AT, coverage: "observed" },
  };
  return {
    ...base,
    ...overrides,
    monitoring: { ...base.monitoring, ...overrides.monitoring },
    recording: { ...base.recording, ...overrides.recording },
    currentHealth: { ...base.currentHealth, ...overrides.currentHealth },
    productionQualification: { ...base.productionQualification, ...overrides.productionQualification },
    observation: { ...base.observation, ...overrides.observation },
  };
}

function expectedState(facts: OperatorSummaryInput["monitoring"]): OperatorMonitoringState {
  if (!facts.receiverOnline) return "offline";
  if (!facts.dataFresh) return "data-late";
  if (facts.alertActive) return "alert";
  if (facts.recovering) return "recovering";
  if (facts.paused) return "paused";
  if (facts.checking || facts.candidateActive || facts.detectingActive) return "checking";
  return "normal";
}

describe("canonical operator monitoring precedence", () => {
  it("[trace:TRUTH-001] resolves every monitoring fact combination in the documented order", () => {
    const booleanFacts = [
      "receiverOnline",
      "dataFresh",
      "alertActive",
      "recovering",
      "paused",
      "checking",
      "candidateActive",
      "detectingActive",
    ] as const;

    for (let mask = 0; mask < 2 ** booleanFacts.length; mask += 1) {
      const facts = { ...input().monitoring };
      booleanFacts.forEach((name, index) => { facts[name] = Boolean(mask & (1 << index)); });
      const summary = resolveOperatorSummary(input({ monitoring: facts }));
      expect(summary.monitoring.state, `mask ${mask}`).toBe(expectedState(facts));
    }
  });

  it("never renders an anomaly candidate as Normal", () => {
    const facts = { candidateActive: true } as const;
    const summary = resolveOperatorSummary(input({ monitoring: { ...input().monitoring, ...facts } }));
    expect(summary.monitoring).toMatchObject({
      state: "checking",
      reasonCode: "candidate-checking",
      actionCode: "wait-for-check",
    });
  });

  it("labels zero-vote detector learning without implying an anomaly", () => {
    const summary = resolveOperatorSummary(input({
      monitoring: { ...input().monitoring, detectingActive: true },
    }));
    expect(summary.monitoring).toMatchObject({
      state: "checking",
      reasonCode: "signal-learning",
      actionCode: "wait-for-check",
    });
  });

  it("keeps an active incident visible while the receiver is Offline", () => {
    const summary = resolveOperatorSummary(input({
      monitoring: { ...input().monitoring, receiverOnline: false },
      incident: {
        id: "incident-1",
        lifecycle: "active",
        verdict: "Suspected RF interference",
        observation: "Signal rose across the watched band.",
        recommendedAction: "Check the independent receiver.",
        evidenceStrength: "Medium",
        startedAt: "2026-08-23T11:58:00.000Z",
      },
    }));

    expect(summary.monitoring.state).toBe("offline");
    expect(summary.incident).toMatchObject({ id: "incident-1", lifecycle: "active" });
  });

  it("keeps a recovering incident visible while browser data is late", () => {
    const summary = resolveOperatorSummary(input({
      monitoring: { ...input().monitoring, dataFresh: false },
      incident: {
        id: "incident-2",
        lifecycle: "recovering",
        verdict: "Suspected RF interference",
        observation: "Signal is returning to its usual range.",
        recommendedAction: "Keep recording.",
        evidenceStrength: "Low",
        startedAt: "2026-08-23T11:58:00.000Z",
      },
    }));

    expect(summary.monitoring.state).toBe("data-late");
    expect(summary.incident).toMatchObject({ id: "incident-2", lifecycle: "recovering" });
  });
});

describe("independent operator truth dimensions", () => {
  it("does not turn current health into production qualification", () => {
    const summary = resolveOperatorSummary(input({
      currentHealth: { state: "normal" },
      productionQualification: { state: "pending", ready: false, epochId: "qualification-pending" },
    }));

    expect(summary.currentHealth.state).toBe("normal");
    expect(summary.productionQualification).toMatchObject({ state: "pending", ready: false });
    expect(presentOperatorSummary(summary)).toMatchObject({
      mode: "Live field data",
      currentHealth: "Normal",
      productionQualification: "Not qualified",
    });
  });

  it("keeps a recording fault separate from a normal RF observation", () => {
    const summary = resolveOperatorSummary(input({ recording: { state: "error" } }));
    expect(summary.monitoring.state).toBe("normal");
    expect(summary.recording).toMatchObject({
      state: "error",
      reasonCode: "recording-error",
      actionCode: "open-recording",
    });
  });

  it("makes Simulation visible and refuses production qualification", () => {
    const summary = resolveOperatorSummary(input({ dataDomain: "test" }));
    expect(summary.dataMode).toBe("simulation");
    expect(summary.currentHealth.state).toBe("simulation");
    expect(summary.productionQualification).toMatchObject({ state: "simulation", ready: false });
    expect(presentOperatorSummary(summary).mode).toBe("Simulation");
  });
});

describe("fail-closed runtime boundaries", () => {
  it.each([
    ["mode", { dataDomain: "mystery" }],
    ["monitoring reason", { monitoring: { ...input().monitoring, reasonCode: "new-server-reason" } }],
    ["monitoring action", { monitoring: { ...input().monitoring, actionCode: "unsafe-action" } }],
    ["recording", { recording: { state: "maybe" } }],
    ["health", { currentHealth: { state: "green-ish" } }],
    ["qualification", { productionQualification: { state: "probably", ready: true } }],
    ["coverage", { observation: { at: OBSERVED_AT, coverage: "fresh-enough" } }],
  ] as Array<[string, Partial<OperatorSummaryInput>]>) ("treats unknown %s values as attention", (_label, overrides) => {
    const summary = resolveOperatorSummary(input(overrides));
    expect(summary.monitoring.state).not.toBe("normal");
    expect(summary.currentHealth).toMatchObject({
      state: "attention",
      reasonCode: "state-code-unknown",
      actionCode: "open-system-health",
    });
    expect(summary.productionQualification.ready).toBe(false);
  });

  it("treats an invalid observation time as unknown, never clean", () => {
    const summary = resolveOperatorSummary(input({ observation: { at: "not-a-time", coverage: "observed" } }));
    expect(summary.monitoring.state).toBe("checking");
    expect(summary.observation).toEqual({ at: null, ageMs: null, coverage: "unknown" });
  });

  it("retains an incident with an unknown lifecycle but does not claim Normal", () => {
    const summary = resolveOperatorSummary(input({
      incident: {
        id: "future-incident",
        lifecycle: "new-lifecycle",
        verdict: "Unrecognized event",
        observation: "State requires review.",
        recommendedAction: "Open System health.",
        evidenceStrength: "Low",
        startedAt: "2026-08-23T11:58:00.000Z",
      },
    }));
    expect(summary.monitoring.state).toBe("checking");
    expect(summary.incident).toMatchObject({ id: "future-incident", lifecycle: "unknown" });
  });
});

describe("canonical observation and presentation", () => {
  it("normalizes one observation timestamp and derives its age once", () => {
    const summary = resolveOperatorSummary(input());
    expect(summary.observation).toEqual({
      at: OBSERVED_AT,
      ageMs: 2_000,
      coverage: "observed",
    });
    expect(JSON.stringify(summary).match(/2026-08-23T11:59:58\.000Z/g)).toHaveLength(1);
  });

  it("deduplicates and bounds affected targets", () => {
    const targets = Array.from({ length: MAX_OPERATOR_AFFECTED_TARGETS + 8 }, (_, index) => ({
      id: `target-${index}`,
      label: `Target ${index}`,
    }));
    targets.splice(1, 0, { id: "target-0", label: "Duplicate" });
    const summary = resolveOperatorSummary(input({ affectedTargets: targets }));
    expect(summary.affectedTargets).toHaveLength(MAX_OPERATOR_AFFECTED_TARGETS);
    expect(summary.affectedTargets.filter((target) => target.id === "target-0")).toHaveLength(1);
  });

  it("has concise copy for every stable reason and action code", () => {
    expect(Object.keys(OPERATOR_REASON_COPY).sort()).toEqual([...OPERATOR_REASON_CODES].sort());
    expect(Object.keys(OPERATOR_ACTION_COPY).sort()).toEqual([...OPERATOR_ACTION_CODES].sort());
    for (const copy of [...Object.values(OPERATOR_REASON_COPY), ...Object.values(OPERATOR_ACTION_COPY)]) {
      expect(copy.length).toBeLessThanOrEqual(40);
      expect(copy).not.toMatch(/[.!?]$/);
    }
  });

  it("validates resolved summaries and rejects partial payloads", () => {
    expect(isOperatorSummary(resolveOperatorSummary(input()))).toBe(true);
    expect(isOperatorSummary({ schemaVersion: 1 })).toBe(false);
  });
});
