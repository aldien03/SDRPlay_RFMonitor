import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  V4_PACKAGED_CASE_MATRIX,
  V4_DOWNSTREAM_DEVELOPMENT_GATES,
  evaluateV4PackagedCase,
  verifyPersistedFrameAttribution,
  verifyV4PackagedBundle,
} from "../scripts/run-v4-packaged-qualification.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

const centerHz = 1_227_600_000;
const release = {
  schemaVersion: 1,
  product: "rf-monitor",
  releaseVersion: "1.0.0",
  buildId: "1.0.0+fixture",
  sourceDigest: "1".repeat(64),
  packageDigest: "2".repeat(64),
  dependencyLockDigest: "3".repeat(64),
};
const qualificationIdentity = {
  release,
  clientBuildId: release.buildId,
  configurationSha256: "4".repeat(64),
  catalogVersion: "test-catalog-v3",
  catalogSha256: "5".repeat(64),
  detectorRuleSetId: "rf-relative-mad-v1",
  detectorRuleSha256: "6".repeat(64),
  expectedSampleRateHz: 10_000_000,
};
const runtimeIdentity = {
  release,
  clientBuildId: release.buildId,
  configurationSha256: qualificationIdentity.configurationSha256,
  catalogVersion: qualificationIdentity.catalogVersion,
  detectorRuleSetId: qualificationIdentity.detectorRuleSetId,
  expectedSampleRateHz: 10_000_000,
};
const commitment = {
  caseId: "wideband-l2",
  scenarioId: "wideband",
  targetId: "gnss-gps-l2c",
  expectedOutcome: "alert",
};

const syntheticExercise = {
  synthetic: true,
  runId: "run-1",
  scenarioId: "wideband",
  scenarioVersion: "1.0.0-schedule-x3",
  scenarioHash: "a".repeat(64),
  validationProtocolVersion: "rf-synthetic-validation-1",
  generatorVersion: "relative-fft-generator-1",
};

function frame(visit: number, lifecycle: "clear" | "active" | "recovering") {
  return {
    frame: {
      dataDomain: "test",
      source: "simulation",
      targetId: commitment.targetId,
      requestedCenterHz: centerHz,
      confirmedCenterHz: centerHz,
      confirmedSampleRateHz: 10_000_000,
      configurationEpoch: 1,
      tuneEpoch: visit,
      visitEpoch: visit,
      visitId: `visit-${visit}`,
      syntheticExercise,
    },
    targetState: { lifecycle },
  };
}

function positiveCapture() {
  return {
    runId: "run-1",
    finalPlayback: {
      runId: "run-1",
      targetId: commitment.targetId,
      centerHz,
      phase: "complete",
      observedOutcome: "alert",
      verdict: "Suspected RF interference",
      scenarioVersion: "1.0.0-schedule-x3",
      scenarioHash: "a".repeat(64),
    },
    phases: new Set(["running", "alert", "recovering", "complete"]),
    operatorStates: new Set(["checking", "alert", "recovering"]),
    affectedTargetIds: new Set([commitment.targetId]),
    incidentTargetIds: new Set([commitment.targetId]),
    qualificationStates: new Set(["simulation:false"]),
    frames: [frame(1, "active"), frame(2, "recovering")],
    controls: 4,
    httpControls: 2,
    websocketControls: 2,
    activeFrameStates: 1,
    recoveringFrameStates: 1,
  };
}

describe("V4 packaged end-to-end qualification assertions", () => {
  it("accepts only a complete scheduled alert and recovery on the committed target", () => {
    expect(evaluateV4PackagedCase(commitment, positiveCapture(), centerHz)).toMatchObject({
      caseId: "wideband-l2",
      observedOutcome: "alert",
      scheduledVisitsObserved: 2,
      immutableEpochsObserved: 2,
      result: "PASS",
    });
  });

  it("fails closed on a missed event, false event, or old-frequency frame", () => {
    const missed = positiveCapture();
    missed.finalPlayback.observedOutcome = "no-alert";
    expect(() => evaluateV4PackagedCase(commitment, missed, centerHz)).toThrow(/expected alert/);

    const stale = positiveCapture();
    stale.frames[1].frame.confirmedCenterHz = 1_575_420_000;
    expect(() => evaluateV4PackagedCase(commitment, stale, centerHz)).toThrow(/old-frequency/);

    const neutralCommitment = { ...commitment, caseId: "neutral", scenarioId: "matched-power-spoofing", expectedOutcome: "no-alert" };
    const falseAlert = positiveCapture();
    falseAlert.finalPlayback.observedOutcome = "no-alert";
    falseAlert.finalPlayback.verdict = "No RF change detected";
    expect(() => evaluateV4PackagedCase(neutralCommitment, falseAlert, centerHz)).toThrow(/false alert/);
  });

  it("accepts isolated synthetic provenance and rejects malformed, mixed-domain, or wrong-center frames", () => {
    const persisted = [
      {
        dataDomain: "test",
        source: "simulation",
        targetId: commitment.targetId,
        requestedCenterHz: centerHz,
        confirmedCenterHz: centerHz,
        configurationEpoch: 1,
        tuneEpoch: 1,
        visitEpoch: 1,
        visitId: "visit-1",
        syntheticExercise,
      },
    ];
    expect(verifyPersistedFrameAttribution(persisted, new Map([[commitment.targetId, centerHz]]))).toMatchObject({
      framesChecked: 1,
      oldFrequencyMisattribution: 0,
      syntheticFramesPersisted: 1,
      syntheticRunIds: ["run-1"],
    });
    expect(() => verifyPersistedFrameAttribution([{
      ...persisted[0],
      syntheticExercise: { ...syntheticExercise, synthetic: false },
    }], new Map([[commitment.targetId, centerHz]]))).toThrow(/invalid synthetic marker/);
    expect(() => verifyPersistedFrameAttribution([{ ...persisted[0], dataDomain: "field" }], new Map([[commitment.targetId, centerHz]]))).toThrow(/test domain/);
    expect(() => verifyPersistedFrameAttribution([{ ...persisted[0], confirmedCenterHz: 1 }], new Map([[commitment.targetId, centerHz]]))).toThrow(/old-frequency/);
  });

  it("verifies exact bundle coverage and rejects a rehashed semantic pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-bundle-"));
    roots.push(root);
    const manifest = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-packaged-end-to-end-manifest",
      campaignId: "fixture",
      release,
      identity: qualificationIdentity,
      catalogVersion: qualificationIdentity.catalogVersion,
      writtenBeforeScenarioExecution: true,
      targetIds: [...new Set(V4_PACKAGED_CASE_MATRIX.map((item) => item.targetId))],
      cases: V4_PACKAGED_CASE_MATRIX.map((item, order) => ({ schemaVersion: 1, order, ...item })),
      casesHash: sha256(JSON.stringify(canonical(V4_PACKAGED_CASE_MATRIX))),
    };
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const report = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-packaged-end-to-end-result",
      campaignId: "fixture",
      manifestHash: sha256(manifestBuffer),
      cases: [],
      qualificationIdentity,
      runtimeIdentity: { before: runtimeIdentity, after: runtimeIdentity, unchanged: true },
      loadedQualificationIdentity: { before: qualificationIdentity, after: qualificationIdentity, unchanged: true },
      result: { packagedEndToEndSubGate: "failed", overallV4: "not-passed", productionReady: false },
      downstreamGates: V4_DOWNSTREAM_DEVELOPMENT_GATES,
    };
    const reportBuffer = Buffer.from(`${JSON.stringify(report)}\n`);
    await Promise.all([
      writeFile(path.join(root, "manifest.json"), manifestBuffer),
      writeFile(path.join(root, "report.json"), reportBuffer),
      writeFile(path.join(root, "SHA256SUMS"), `${sha256(manifestBuffer)}  manifest.json\n${sha256(reportBuffer)}  report.json\n`),
    ]);
    await expect(verifyV4PackagedBundle(root)).resolves.toMatchObject({ valid: true, packagedEndToEndSubGate: "failed" });

    const forgedReport = { ...report, result: { ...report.result, packagedEndToEndSubGate: "passed" } };
    const forgedBuffer = Buffer.from(`${JSON.stringify(forgedReport)}\n`);
    await writeFile(path.join(root, "report.json"), forgedBuffer);
    await writeFile(path.join(root, "SHA256SUMS"), `${sha256(manifestBuffer)}  manifest.json\n${sha256(forgedBuffer)}  report.json\n`);
    await expect(verifyV4PackagedBundle(root)).rejects.toThrow(/incomplete or semantically invalid cases/);
  });

  it("accepts complete isolated test provenance and rejects any field-domain run marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-passing-bundle-"));
    roots.push(root);
    const targetIds = [...new Set(V4_PACKAGED_CASE_MATRIX.map((item) => item.targetId))];
    const manifest = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-packaged-end-to-end-manifest",
      campaignId: "passing-fixture",
      release,
      identity: qualificationIdentity,
      catalogVersion: qualificationIdentity.catalogVersion,
      writtenBeforeScenarioExecution: true,
      targetIds,
      cases: V4_PACKAGED_CASE_MATRIX.map((item, order) => ({ schemaVersion: 1, order, ...item })),
      casesHash: sha256(JSON.stringify(canonical(V4_PACKAGED_CASE_MATRIX))),
    };
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const cases = V4_PACKAGED_CASE_MATRIX.map((item, index) => ({
      ...item,
      runId: `run-${index + 1}`,
      observedOutcome: item.expectedOutcome,
      verdict: item.expectedOutcome === "alert"
        ? "Suspected RF interference"
        : item.expectedOutcome === "unknown" ? "Test inconclusive" : "No RF change detected",
      phases: item.expectedOutcome === "alert" ? ["alert", "recovering", "complete"] : ["complete"],
      operatorStates: item.expectedOutcome === "alert" ? ["alert", "recovering"] : ["checking"],
      result: "PASS",
    }));
    const runIds = cases.map((item) => item.runId);
    const report = {
      schemaVersion: 1,
      recordType: "rf-monitor-v4-packaged-end-to-end-result",
      campaignId: manifest.campaignId,
      manifestHash: sha256(manifestBuffer),
      cases,
      release: { before: release, after: release, unchanged: true },
      runtime: { simulation: true, physicalReceiver: "not-run" },
      qualificationIdentity,
      runtimeIdentity: { before: runtimeIdentity, after: runtimeIdentity, unchanged: true },
      loadedQualificationIdentity: { before: qualificationIdentity, after: qualificationIdentity, unchanged: true },
      evidence: {
        sessions: [{ lifecycle: "Complete", verifierOutcome: "PASS" }],
        attribution: {
          oldFrequencyMisattribution: 0,
          syntheticFramesPersisted: runIds.length,
          syntheticRunIds: runIds,
          targetIds,
        },
        syntheticProvenance: cases.map((item) => ({
          caseId: item.caseId,
          runId: item.runId,
          scenarioId: item.scenarioId,
          targetId: item.targetId,
          frames: 1,
          events: item.expectedOutcome === "alert" ? 2 : 0,
          completedVisits: item.expectedOutcome === "unknown" ? 0 : 1,
          unknownVisits: item.expectedOutcome === "unknown" ? 1 : 0,
        })),
      },
      isolation: {
        fieldUnchanged: true,
        testChanged: true,
        syntheticPersistence: {
          test: { markerOccurrences: runIds.length, runIds: runIds.map((runId) => ({ runId, occurrences: 1 })) },
          field: { markerOccurrences: 0, runIds: runIds.map((runId) => ({ runId, occurrences: 0 })) },
        },
      },
      result: { packagedEndToEndSubGate: "passed", overallV4: "not-passed", productionReady: false },
      downstreamGates: V4_DOWNSTREAM_DEVELOPMENT_GATES,
    };
    const writeReport = async (value: typeof report) => {
      const reportBuffer = Buffer.from(`${JSON.stringify(value)}\n`);
      await Promise.all([
        writeFile(path.join(root, "manifest.json"), manifestBuffer),
        writeFile(path.join(root, "report.json"), reportBuffer),
        writeFile(path.join(root, "SHA256SUMS"), `${sha256(manifestBuffer)}  manifest.json\n${sha256(reportBuffer)}  report.json\n`),
      ]);
    };
    await writeReport(report);
    await expect(verifyV4PackagedBundle(root)).resolves.toMatchObject({ valid: true, packagedEndToEndSubGate: "passed" });

    const mixed = structuredClone(report);
    mixed.isolation.syntheticPersistence.field.markerOccurrences = 1;
    mixed.isolation.syntheticPersistence.field.runIds[0].occurrences = 1;
    await writeReport(mixed);
    await expect(verifyV4PackagedBundle(root)).rejects.toThrow(/only under isolated test evidence/);
  });
});
