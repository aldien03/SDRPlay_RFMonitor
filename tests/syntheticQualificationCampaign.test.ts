import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildV4CampaignCommitments,
  executeV4DetectorCampaign,
  verifyV4CampaignBundle,
  type FrozenCandidateIdentity,
} from "../src/server/syntheticQualificationCampaign";
import {
  prepareSyntheticQualificationDefinition,
  runSyntheticQualificationDefinition,
} from "../src/server/syntheticQualificationRunner";
import { createRandomizedSyntheticScenario } from "../src/server/syntheticValidation";
import { TEST_CATALOG } from "./catalogFixture";

const candidate: FrozenCandidateIdentity = {
  schemaVersion: 1,
  product: "rf-monitor",
  releaseVersion: "1.0.0",
  buildId: "1.0.0+test",
  sourceDigest: "1".repeat(64),
  packageDigest: "2".repeat(64),
  dependencyLockDigest: "3".repeat(64),
};

const temporaryPaths: string[] = [];
async function makeRemovable(root: string): Promise<void> {
  let entries;
  try {
    entries = await readFile(path.join(root, "SHA256SUMS"));
  } catch {
    entries = undefined;
  }
  if (entries) await chmod(path.join(root, "SHA256SUMS"), 0o640).catch(() => undefined);
  await chmod(path.join(root, "results"), 0o750).catch(() => undefined);
  await chmod(root, 0o750).catch(() => undefined);
}
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (entry) => {
    const artifactRoot = path.join(entry, "artifacts");
    try {
      await makeRemovable(path.join(artifactRoot, "v4-resume-test"));
    } catch {
      // Best-effort cleanup for intentionally immutable test artifacts.
    }
    await rm(entry, { recursive: true, force: true });
  }));
});

describe("V4 conditional detector campaign", () => {
  it("prepares a stable truth commitment and executes the exact catalog target", () => {
    const scenario = createRandomizedSyntheticScenario({
      catalog: TEST_CATALOG,
      targetId: "gnss-glonass-g1",
      family: "wideband",
      trialIndex: 7,
    });
    const options = {
      bandCatalog: TEST_CATALOG,
      softwareBuild: candidate,
      runId: "v4-stable-run",
      qualificationLevel: "isolated-randomized" as const,
    };
    const first = prepareSyntheticQualificationDefinition(scenario, "blinded", options);
    const second = prepareSyntheticQualificationDefinition(scenario, "blinded", options);
    expect(second.metadata.truthCommitment).toBe(first.metadata.truthCommitment);

    const report = runSyntheticQualificationDefinition(scenario, "blinded", {
      ...options,
      expectedTruthCommitment: first.metadata.truthCommitment,
    });
    expect(report.scenario.target).toEqual({
      id: "gnss-glonass-g1",
      label: "GLONASS G1",
      centerHz: 1_601_719_000,
    });
    expect(report.qualification.level).toBe("isolated-randomized");
    expect(report.truth).toMatchObject({ commitment: first.metadata.truthCommitment, verified: true });
    expect(report.provenance.configurationHash).toBe(first.provenance.configurationHash);
  });

  it("freezes deterministic and randomized commitments for every target/family", () => {
    const commitments = buildV4CampaignCommitments({
      campaignId: "v4-test-plan",
      catalog: TEST_CATALOG,
      candidate,
      randomizedRunsPerTargetFamily: 2,
    });
    expect(commitments).toHaveLength(40 + 4 * 10 * 2);
    expect(new Set(commitments.map((entry) => entry.caseId))).toHaveLength(commitments.length);
    expect(commitments.every((entry, index) => entry.order === index && entry.truthCommitment.match(/^[a-f0-9]{64}$/))).toBe(true);
    expect(commitments.filter((entry) => entry.level === "isolated-deterministic")).toHaveLength(40);
    expect(commitments.filter((entry) => entry.level === "isolated-randomized" && entry.targetId === "gnss-gps-l2c" && entry.family === "cw")).toHaveLength(2);
  });

  it("detects the frozen high-margin pulse and motion envelope on every Tier-1 target", () => {
    const targetIds = TEST_CATALOG.captureTargets
      .filter((target) => target.service === "gnss" && target.tier === "tier1" && target.defaultEnabled)
      .map((target) => target.id);
    expect(targetIds).toHaveLength(4);

    for (const targetId of targetIds) {
      for (const family of ["pulsed-wideband", "moving-narrowband"] as const) {
        for (let trialIndex = 0; trialIndex < 25; trialIndex += 1) {
          const scenario = createRandomizedSyntheticScenario({
            catalog: TEST_CATALOG,
            targetId,
            family,
            trialIndex,
          });
          const event = scenario.events[0];
          if (event.kind === "pulsed-wideband") {
            expect(event.periodMs).toBe(1_000);
            expect(event.dutyCycle).toBeGreaterThanOrEqual(0.6);
            expect(event.dutyCycle).toBeLessThanOrEqual(0.9);
          } else if (event.kind === "moving-narrowband") {
            expect(event.sweepPeriodMs).toBeGreaterThanOrEqual(90_000);
            expect(event.sweepPeriodMs).toBeLessThanOrEqual(180_000);
          }
          const report = runSyntheticQualificationDefinition(scenario, "blinded", {
            bandCatalog: TEST_CATALOG,
            softwareBuild: candidate,
            runId: `v4-observable-${targetId}-${family}-${trialIndex}`,
            qualificationLevel: "isolated-randomized",
          });
          expect(report.score.unexpectedAlerts, `${targetId}/${family}/${trialIndex}`).toBe(0);
          expect(report.score.detectedExpectedEvents, `${targetId}/${family}/${trialIndex}`).toBe(1);
          expect(report.passed, `${targetId}/${family}/${trialIndex}`).toBe(true);
        }
      }
    }
  });

  it("resumes from durable chunks and publishes a hash-verified fail-closed bundle", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-campaign-"));
    temporaryPaths.push(temporary);
    const common = {
      repositoryRoot: process.cwd(),
      outputRoot: path.join(temporary, "artifacts"),
      campaignId: "v4-resume-test",
      catalog: TEST_CATALOG,
      candidate,
      readCandidate: async () => candidate,
      protectedFieldRoot: path.join(temporary, "field-domain-does-not-exist"),
      randomizedRunsPerTargetFamily: 1,
      chunkCases: 20,
    };
    const paused = await executeV4DetectorCampaign({ ...common, maxNewCases: 3 });
    expect(paused).toMatchObject({ state: "paused", completedCases: 3, totalCases: 80 });

    const completed = await executeV4DetectorCampaign(common);
    expect(completed.state).toBe("complete");
    expect(completed.report).toMatchObject({
      executedCases: 80,
      truthCommitmentsVerified: 80,
      isolation: { unchanged: true, fieldWritesReported: 0 },
      result: {
        randomizedStatisticalCriteriaPassed: false,
        detectorStatisticalSubGate: "failed",
        overallV4: "not-passed",
        productionReady: false,
      },
      downstreamGates: { V5: "not-run", V6: "not-run" },
    });
    expect(completed.report?.remainingV4Blockers.join(" ")).toMatch(/main UI/);
    await expect(verifyV4CampaignBundle(completed.bundlePath)).resolves.toMatchObject({ valid: true });
    const commitments = await readFile(path.join(completed.bundlePath, "commitments.jsonl"), "utf8");
    expect(commitments.trim().split("\n")).toHaveLength(80);

    await chmod(completed.bundlePath, 0o750);
    const sumsPath = path.join(completed.bundlePath, "SHA256SUMS");
    await chmod(sumsPath, 0o640);
    const originalSums = await readFile(sumsPath, "utf8");
    await writeFile(sumsPath, `${originalSums.trimEnd().split("\n").slice(1).join("\n")}\n`);
    await expect(verifyV4CampaignBundle(completed.bundlePath)).rejects.toThrow(/exact committed file set/);

    await writeFile(sumsPath, originalSums);
    const unexpectedPath = path.join(completed.bundlePath, "unexpected.json");
    await writeFile(unexpectedPath, "{}\n");
    await expect(verifyV4CampaignBundle(completed.bundlePath)).rejects.toThrow(/unexpected root entry/);
    await unlink(unexpectedPath);

    const reportPath = path.join(completed.bundlePath, "report.json");
    await chmod(reportPath, 0o640);
    const malformedReport = JSON.parse(await readFile(reportPath, "utf8"));
    malformedReport.executedCases -= 1;
    const malformedContents = `${JSON.stringify(malformedReport, null, 2)}\n`;
    await writeFile(reportPath, malformedContents);
    const malformedHash = createHash("sha256").update(malformedContents).digest("hex");
    await writeFile(sumsPath, originalSums.replace(/^[a-f0-9]{64}  report\.json$/m, `${malformedHash}  report.json`));
    await expect(verifyV4CampaignBundle(completed.bundlePath)).rejects.toThrow(/report semantics/);

    await writeFile(reportPath, `${JSON.stringify(completed.report, null, 2)}\n`);
    await writeFile(sumsPath, originalSums);
    await chmod(path.join(completed.bundlePath, "results"), 0o750);
    const symlinkPath = path.join(completed.bundlePath, "results", "chunk-999999.json");
    await symlink(path.join(completed.bundlePath, "report.json"), symlinkPath);
    await expect(verifyV4CampaignBundle(completed.bundlePath)).rejects.toThrow(/invalid result entry/);
  });
});
