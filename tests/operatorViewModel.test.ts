import { describe, expect, it } from "vitest";
import {
  currentOperatorEvent,
  isRealOperatorAlert,
  mergeCanonicalOperatorSummary,
  operatorAffectedTargetIds,
  operatorAnnouncement,
  operatorObservationForSurface,
  operatorObservationMatchesTargets,
} from "../src/client/operatorViewModel";
import { resolveOperatorSummary, type OperatorSummaryInput } from "../src/shared/operatorSummary";
import type { DetectionEvent, MonitorSnapshot } from "../src/shared/types";

const generatedAt = "2026-08-23T12:00:00.000Z";
const monitoringFacts: OperatorSummaryInput["monitoring"] = {
  receiverOnline: true,
  dataFresh: true,
  paused: false,
  alertActive: false,
  recovering: false,
  candidateActive: false,
  detectingActive: false,
  checking: false,
  since: generatedAt,
};

function summary(overrides: Partial<OperatorSummaryInput> = {}) {
  const base: OperatorSummaryInput = {
    generatedAt,
    serverBuildId: "release-a",
    dataDomain: "field",
    monitoring: monitoringFacts,
    recording: { state: "recording" },
    currentHealth: { state: "normal" },
    productionQualification: { state: "pending", ready: false },
    affectedTargets: [{ id: "gnss-l1", label: "GNSS L1", frequencyLabel: "1575.420 MHz" }],
    observation: { at: generatedAt, coverage: "observed", targetId: "gnss-l1" },
  };
  return resolveOperatorSummary({
    ...base,
    ...overrides,
    monitoring: { ...base.monitoring, ...overrides.monitoring },
    recording: { ...base.recording, ...overrides.recording },
    currentHealth: { ...base.currentHealth, ...overrides.currentHealth },
    productionQualification: { ...base.productionQualification, ...overrides.productionQualification },
    observation: { ...base.observation, ...overrides.observation },
  });
}

function event(id: string): DetectionEvent {
  return { id } as DetectionEvent;
}

describe("operator dashboard view model", () => {
  it("never promotes the newest historical event to the current incident", () => {
    const historical = event("historical");
    const snapshot = { operatorSummary: summary(), events: [historical] } as unknown as MonitorSnapshot;
    expect(currentOperatorEvent(snapshot)).toBeUndefined();
  });

  it("resolves only the incident named by the canonical server summary", () => {
    const current = event("current");
    const historical = event("historical");
    const operatorSummary = summary({
      monitoring: { ...monitoringFacts, alertActive: true },
      incident: {
        id: "current",
        lifecycle: "active",
        verdict: "Suspected RF interference",
        observation: "Signal above normal",
        recommendedAction: "Check navigation sources",
        evidenceStrength: "Medium",
        startedAt: generatedAt,
      },
    });
    const snapshot = { operatorSummary, events: [historical, current], activeEvent: historical } as unknown as MonitorSnapshot;
    expect(currentOperatorEvent(snapshot)).toBe(current);
    expect(operatorAffectedTargetIds(operatorSummary)).toEqual(["gnss-l1"]);
  });

  it("announces real field alerts assertively and simulation alerts politely", () => {
    const incident = {
      id: "current",
      lifecycle: "active",
      verdict: "Suspected RF interference",
      observation: "Signal above normal",
      recommendedAction: "Check navigation sources",
      evidenceStrength: "Medium",
      startedAt: generatedAt,
    } as const;
    const field = summary({ monitoring: { ...monitoringFacts, alertActive: true }, incident });
    const simulation = summary({ dataDomain: "test", monitoring: { ...monitoringFacts, alertActive: true }, incident: { ...incident, synthetic: true } });

    expect(isRealOperatorAlert(field)).toBe(true);
    expect(isRealOperatorAlert(simulation)).toBe(false);
    expect(operatorAnnouncement(field)).toContain("GNSS L1");
    expect(operatorAnnouncement(field)).toContain("Action: Check navigation sources");
    expect(operatorAnnouncement(field)).toContain("Recording on");
    expect(operatorAnnouncement(field)).not.toContain("Recording recording");
    expect(operatorAnnouncement(simulation)).toMatch(/^Simulation\./);
  });

  it("fails closed when the canonical observation is unknown", () => {
    const unknown = summary({ observation: { at: generatedAt, coverage: "unknown" } });
    expect(operatorObservationForSurface(unknown, "footer")).toEqual({ at: null, ageMs: null, ageLabel: "Unknown" });
  });

  it("never applies one target's observation clock to another affected feed", () => {
    const multiTarget = summary({
      affectedTargets: [
        { id: "gnss-l1", label: "GNSS L1" },
        { id: "gnss-l5", label: "GNSS L5" },
      ],
      observation: { at: generatedAt, coverage: "observed", targetId: "gnss-l1" },
    });
    expect(operatorObservationMatchesTargets(multiTarget, ["gnss-l1"])).toBe(true);
    expect(operatorObservationMatchesTargets(multiTarget, ["gnss-l5"])).toBe(false);
  });

  it("allows a legitimate target switch even when its observation is older", () => {
    const current = summary({ observation: { at: "2026-08-23T12:00:05.000Z", coverage: "observed", targetId: "gnss-l1" } });
    const incoming = summary({ observation: { at: "2026-08-23T12:00:04.000Z", coverage: "observed", targetId: "gnss-l5" } });
    expect(mergeCanonicalOperatorSummary(current, incoming).observation).toMatchObject({
      at: "2026-08-23T12:00:04.000Z",
      targetId: "gnss-l5",
    });
  });

  it("keeps card, pinned, incident, and footer clocks identical and non-regressing across 100,000 deltas", () => {
    const baseMs = Date.parse("2026-08-23T00:00:00.000Z");
    let current = summary({
      generatedAt: new Date(baseMs).toISOString(),
      observation: { at: new Date(baseMs).toISOString(), coverage: "observed" },
    });
    let lastAtMs = baseMs;
    const surfaces = ["card", "pinned", "incident", "footer"] as const;

    for (let index = 1; index <= 100_000; index += 1) {
      const generatedAtMs = baseMs + index * 1_000;
      const candidateAtMs = index % 17 === 0
        ? Math.max(baseMs, lastAtMs - 5_000)
        : generatedAtMs;
      const incoming = summary({
        generatedAt: new Date(generatedAtMs).toISOString(),
        observation: { at: new Date(candidateAtMs).toISOString(), coverage: "observed" },
      });
      current = mergeCanonicalOperatorSummary(current, incoming);
      const views = surfaces.map((surface) => operatorObservationForSurface(current, surface));
      const reference = views[0];
      if (views.some((view) => view.at !== reference.at || view.ageMs !== reference.ageMs || view.ageLabel !== reference.ageLabel)) {
        throw new Error(`Operator observation disagreement at delta ${index}`);
      }
      const selectedAtMs = reference.at ? Date.parse(reference.at) : Number.NEGATIVE_INFINITY;
      if (selectedAtMs < lastAtMs) throw new Error(`Operator observation regressed at delta ${index}`);
      lastAtMs = selectedAtMs;
    }

    expect(lastAtMs).toBe(baseMs + 100_000 * 1_000);
  });
});
