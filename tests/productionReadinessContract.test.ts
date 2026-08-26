import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { presentOperatorSummary, resolveOperatorSummary } from "../src/shared/operatorSummary";
import type { ProductionQualification } from "../src/shared/types";
import { productionReadyForHealth } from "../src/server/productionQualification";

const localSoakOnly: ProductionQualification = {
  schemaVersion: 1,
  epochId: "qualification-local-soak-only",
  fingerprint: "a".repeat(64),
  state: "pending",
  ready: false,
  startedAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  releaseBuildId: "release-a",
  configurationHash: "b".repeat(64),
  commissioningEpochId: "commissioning-a",
  blockers: [
    "external-qualification-approval-missing",
    "hardware-recovery-qualification-pending",
    "fault-qualification-pending",
    "evidence-continuity-qualification-pending",
  ],
  faults: [],
  requirements: {
    immutableRelease: true,
    clientServerBuildMatch: true,
    productionSampleRate: true,
    sampleRateConfirmed: true,
    physicalReceiver: true,
    supportedReceiverModel: true,
    stableReceiverIdentity: true,
    protectedBaselines: true,
    scanObjectives: true,
    cleanResourceSoak: true,
    soakComplete: true,
    externalApproval: false,
    installedChainQualified: false,
    timingAndBaselineQualified: false,
    hardwareRecoveryQualified: false,
    faultQualification: false,
    evidenceContinuityQualified: false,
    clean72HourSoakQualified: false,
    controlledPilotQualified: false,
  },
};

function operatorSummary(qualification: ProductionQualification) {
  return resolveOperatorSummary({
    generatedAt: "2026-08-23T00:00:00.000Z",
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
    },
    recording: { state: "recording" },
    currentHealth: { state: "normal" },
    productionQualification: {
      state: qualification.state,
      ready: qualification.ready,
      epochId: qualification.epochId,
    },
    affectedTargets: [],
    observation: { at: "2026-08-23T00:00:00.000Z", coverage: "observed" },
  });
}

describe("production readiness boundary", () => {
  it("keeps a healthy completed 24-hour local gate unqualified in the API contract and operator view", () => {
    const currentHealth = { ready: true };
    const productionReady = productionReadyForHealth(currentHealth, localSoakOnly);
    const compatibilityApi = { currentHealth, productionQualification: localSoakOnly, productionReady, ok: productionReady };

    expect(compatibilityApi).toMatchObject({
      currentHealth: { ready: true },
      productionQualification: {
        state: "pending",
        ready: false,
        requirements: { soakComplete: true, externalApproval: false },
      },
      productionReady: false,
      ok: false,
    });
    const operator = operatorSummary(localSoakOnly);
    expect(operator.currentHealth.state).toBe("normal");
    expect(operator.productionQualification).toMatchObject({ state: "pending", ready: false });
    expect(presentOperatorSummary(operator).productionQualification).toBe("Not qualified");
  });

  it("makes doctor require the approved V0-V7 gates without requiring optional V8/V9 assurance", () => {
    const filter = path.resolve("deploy/production-ready.jq");
    const base = {
      schemaVersion: 2,
      currentHealth: { ready: true },
      productionQualification: localSoakOnly,
      productionReady: false,
    };
    const rejected = spawnSync("jq", ["-e", "-f", filter], { input: JSON.stringify(base), encoding: "utf8" });
    expect(rejected.status).toBe(1);

    const approved: ProductionQualification = {
      ...localSoakOnly,
      state: "qualified",
      ready: true,
      blockers: [],
      requirements: {
        ...localSoakOnly.requirements,
        externalApproval: true,
        installedChainQualified: true,
        timingAndBaselineQualified: true,
        hardwareRecoveryQualified: true,
        faultQualification: true,
        evidenceContinuityQualified: true,
        clean72HourSoakQualified: false,
        controlledPilotQualified: false,
      },
    };
    expect(productionReadyForHealth({ ready: true }, approved)).toBe(true);
    expect(() => execFileSync("jq", ["-e", "-f", filter], {
      input: JSON.stringify({ ...base, productionQualification: approved, productionReady: true }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })).not.toThrow();

    const missingEvidence = {
      ...approved,
      requirements: { ...approved.requirements, evidenceContinuityQualified: false },
    };
    expect(productionReadyForHealth({ ready: true }, missingEvidence)).toBe(false);
    expect(spawnSync("jq", ["-e", "-f", filter], {
      input: JSON.stringify({ ...base, productionQualification: missingEvidence, productionReady: true }),
      encoding: "utf8",
    }).status).toBe(1);
  });
});
