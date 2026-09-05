import { describe, expect, it } from "vitest";
import { surfaceAlertCopy } from "../src/client/SurfaceAlertBanner";
import { presentOperatorSummary, resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { OperatorSummaryInput } from "../src/shared/operatorSummary";

function input(overrides: Partial<OperatorSummaryInput> = {}): OperatorSummaryInput {
  const base: OperatorSummaryInput = {
    generatedAt: "2026-08-23T12:00:00.000Z",
    serverBuildId: "test",
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
    },
    recording: { state: "recording" },
    currentHealth: { state: "normal" },
    productionQualification: { state: "qualified", ready: true },
    affectedTargets: [{ id: "gnss-l1", label: "GNSS L1" }],
    observation: { at: "2026-08-23T11:59:58.000Z", coverage: "observed" },
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

describe("surfaceAlertCopy", () => {
  it("returns undefined for a normal monitoring state, and separately for checking", () => {
    const normal = resolveOperatorSummary(input());
    expect(normal.monitoring.state).toBe("normal");
    expect(surfaceAlertCopy(normal)).toBeUndefined();

    const checking = resolveOperatorSummary(input({ monitoring: { ...input().monitoring, checking: true } }));
    expect(checking.monitoring.state).toBe("checking");
    expect(surfaceAlertCopy(checking)).toBeUndefined();
  });

  it("returns a copy object for alert, with heading equal to the presented monitoring label", () => {
    const summary = resolveOperatorSummary(input({ monitoring: { ...input().monitoring, alertActive: true } }));
    expect(summary.monitoring.state).toBe("alert");
    const copy = surfaceAlertCopy(summary);
    expect(copy).toBeDefined();
    expect(copy?.heading).toBe(presentOperatorSummary(summary).monitoring);
  });

  it("prefers the incident observation over the presented observation, joined after the affected target labels", () => {
    const summary = resolveOperatorSummary(input({
      monitoring: { ...input().monitoring, alertActive: true },
      incident: {
        id: "incident-1",
        lifecycle: "active",
        verdict: "Interference likely",
        observation: "Strong repeated signal on GNSS L1",
        recommendedAction: "Open incident",
        evidenceStrength: "Medium",
        startedAt: "2026-08-23T11:58:00.000Z",
      },
      affectedTargets: [{ id: "gnss-l1", label: "GNSS L1" }, { id: "gnss-l2", label: "GNSS L2" }],
    }));
    const copy = surfaceAlertCopy(summary);
    expect(copy?.detail).toBe("GNSS L1, GNSS L2 · Strong repeated signal on GNSS L1");
  });

  it("sets simulation true when dataMode is simulation and false when it is field", () => {
    const simulation = resolveOperatorSummary(input({ dataDomain: "simulation", monitoring: { ...input().monitoring, alertActive: true } }));
    expect(surfaceAlertCopy(simulation)?.simulation).toBe(true);

    const field = resolveOperatorSummary(input({ monitoring: { ...input().monitoring, alertActive: true } }));
    expect(surfaceAlertCopy(field)?.simulation).toBe(false);
  });
});
