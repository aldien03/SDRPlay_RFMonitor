import { describe, expect, it } from "vitest";
import { resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { MonitorSnapshot, ProductionQualification } from "../src/shared/types";
import { applyAuthoritativeOperatorRuntime } from "../src/server/operatorSnapshot";

const generatedAt = "2026-08-23T12:00:00.000Z";

function qualification(state: ProductionQualification["state"], ready: boolean): ProductionQualification {
  return {
    schemaVersion: 1,
    epochId: `qualification-${state}`,
    fingerprint: "a".repeat(64),
    state,
    ready,
    startedAt: generatedAt,
    updatedAt: generatedAt,
    releaseBuildId: "server-a",
    configurationHash: "b".repeat(64),
    commissioningEpochId: "commissioning-a",
    blockers: ready ? [] : ["qualification-soak-incomplete"],
    faults: [],
    requirements: {
      immutableRelease: ready,
      clientServerBuildMatch: ready,
      productionSampleRate: true,
      sampleRateConfirmed: ready,
      physicalReceiver: ready,
      supportedReceiverModel: ready,
      stableReceiverIdentity: ready,
      protectedBaselines: ready,
      scanObjectives: ready,
      cleanResourceSoak: ready,
      soakComplete: ready,
      externalApproval: ready,
      installedChainQualified: ready,
      timingAndBaselineQualified: ready,
      hardwareRecoveryQualified: ready,
      faultQualification: ready,
      evidenceContinuityQualified: ready,
      clean72HourSoakQualified: false,
      controlledPilotQualified: false,
    },
  };
}

function sourceSnapshot(): MonitorSnapshot {
  const operatorSummary = resolveOperatorSummary({
    generatedAt,
    serverBuildId: "server-a",
    dataDomain: "field",
    monitoring: {
      receiverOnline: false,
      dataFresh: false,
      paused: false,
      alertActive: true,
      recovering: false,
      candidateActive: false,
      detectingActive: false,
      checking: false,
    },
    incident: {
      id: "incident-a",
      lifecycle: "active",
      verdict: "Suspected RF interference",
      observation: "Signal rose across the watched band.",
      recommendedAction: "Check the independent receiver.",
      evidenceStrength: "Medium",
      startedAt: "2026-08-23T11:59:00.000Z",
    },
    recording: { state: "recording" },
    currentHealth: { state: "attention" },
    productionQualification: { state: "pending", ready: false },
    affectedTargets: [{ id: "gnss-l1", label: "GNSS L1" }],
    observation: { at: "2026-08-23T11:59:58.000Z", coverage: "not-observed" },
  });
  return {
    generatedAt,
    dataDomain: "field",
    identity: {
      release: { serverBuildId: "server-a" },
    },
    operatorSummary,
  } as unknown as MonitorSnapshot;
}

describe("authoritative operator runtime overlay", () => {
  it("refreshes health, recording, and persisted qualification without losing an incident", () => {
    const snapshot = applyAuthoritativeOperatorRuntime(sourceSnapshot(), {
      productionQualification: qualification("failed", false),
      currentHealthState: "critical",
      recordingState: "error",
    });

    expect(snapshot.operatorSummary).toMatchObject({
      monitoring: { state: "offline" },
      incident: { id: "incident-a", lifecycle: "active" },
      affectedTargets: [{ id: "gnss-l1" }],
      observation: { at: "2026-08-23T11:59:58.000Z", coverage: "not-observed" },
      currentHealth: { state: "critical", reasonCode: "health-critical" },
      recording: { state: "error", reasonCode: "recording-error" },
      productionQualification: {
        state: "failed",
        ready: false,
        epochId: "qualification-failed",
      },
    });
  });

  it("does not let current health qualify a pending installation", () => {
    const snapshot = applyAuthoritativeOperatorRuntime(sourceSnapshot(), {
      productionQualification: qualification("pending", false),
      currentHealthState: "normal",
      recordingState: "recording",
    });

    expect(snapshot.operatorSummary.currentHealth.state).toBe("normal");
    expect(snapshot.operatorSummary.productionQualification).toMatchObject({ state: "pending", ready: false });
  });

  it("does not present a nominal qualified flag when external recovery/fault approval is absent", () => {
    const inconsistent = qualification("qualified", true);
    inconsistent.requirements.externalApproval = false;
    inconsistent.requirements.hardwareRecoveryQualified = false;
    inconsistent.requirements.faultQualification = false;
    const snapshot = applyAuthoritativeOperatorRuntime(sourceSnapshot(), {
      productionQualification: inconsistent,
      currentHealthState: "normal",
      recordingState: "recording",
    });

    expect(snapshot.operatorSummary.currentHealth.state).toBe("normal");
    expect(snapshot.operatorSummary.productionQualification).toMatchObject({ state: "pending", ready: false });
  });
});
