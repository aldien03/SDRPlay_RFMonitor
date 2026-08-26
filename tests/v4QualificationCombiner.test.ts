import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { V4_PACKAGED_CASE_MATRIX } from "../scripts/run-v4-packaged-qualification.mjs";
import {
  combineV4Qualification,
  sha256CanonicalV4,
  verifyPassingV4PackagedBundle,
  verifyV4CombinedBundle,
  type V4CombinedIdentity,
} from "../src/server/v4QualificationCombiner";
import { parseV4CombineArguments, V4_COMBINE_HELP } from "../src/server/v4QualificationCombinerCli";

const temporaryRoots: string[] = [];
const targetIds = [
  "gnss-glonass-g1",
  "gnss-gps-l2c",
  "gnss-l1-e1-b1c-sbas",
  "gnss-l5-e5a-b2a",
];
const release = {
  schemaVersion: 1 as const,
  product: "rf-monitor" as const,
  releaseVersion: "1.0.0",
  buildId: "1.0.0+v4-combine-fixture",
  sourceDigest: "1".repeat(64),
  packageDigest: "2".repeat(64),
  dependencyLockDigest: "3".repeat(64),
};
const identity: V4CombinedIdentity = {
  release,
  clientBuildId: release.buildId,
  configurationSha256: "4".repeat(64),
  catalogVersion: "catalog-v3-fixture",
  catalogSha256: "5".repeat(64),
  detectorRuleSetId: "rf-relative-mad-v1",
  detectorRuleSha256: "6".repeat(64),
  expectedSampleRateHz: 10_000_000,
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function makeWritable(root: string): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  await chmod(root, 0o750).catch(() => undefined);
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(absolute);
    else await chmod(absolute, 0o640).catch(() => undefined);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

async function writeChecksums(root: string, relatives: string[]): Promise<void> {
  const lines: string[] = [];
  for (const relative of [...relatives].sort()) {
    lines.push(`${sha256(await readFile(path.join(root, ...relative.split("/"))))}  ${relative}`);
  }
  await writeFile(path.join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function refreshExistingChecksums(root: string): Promise<void> {
  const checksumPath = path.join(root, "SHA256SUMS");
  const relatives = (await readFile(checksumPath, "utf8")).trimEnd().split("\n").map((line) => line.slice(66));
  await chmod(checksumPath, 0o640).catch(() => undefined);
  await writeChecksums(root, relatives);
}

function runtimeBinding(boundIdentity = identity) {
  return {
    release: boundIdentity.release,
    clientBuildId: boundIdentity.clientBuildId,
    configurationSha256: boundIdentity.configurationSha256,
    catalogVersion: boundIdentity.catalogVersion,
    detectorRuleSetId: boundIdentity.detectorRuleSetId,
    expectedSampleRateHz: boundIdentity.expectedSampleRateHz,
  };
}

async function createPackagedBundle(root: string, boundIdentity = identity): Promise<void> {
  await mkdir(root, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-packaged-end-to-end-manifest",
    campaignId: "packaged-fixture",
    createdAt: "2026-08-23T00:00:00.000Z",
    release: boundIdentity.release,
    identity: boundIdentity,
    catalogVersion: boundIdentity.catalogVersion,
    targetIds,
    cases: V4_PACKAGED_CASE_MATRIX.map((entry, order) => ({ schemaVersion: 1, order, ...entry })),
    casesHash: sha256CanonicalV4(V4_PACKAGED_CASE_MATRIX),
    writtenBeforeScenarioExecution: true,
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const cases = V4_PACKAGED_CASE_MATRIX.map((entry, index) => ({
    ...entry,
    runId: `run-${index + 1}`,
    observedOutcome: entry.expectedOutcome,
    verdict: entry.expectedOutcome === "alert"
      ? "Suspected RF interference"
      : entry.expectedOutcome === "unknown" ? "Test inconclusive" : "No RF change detected",
    phases: entry.expectedOutcome === "alert" ? ["alert", "recovering", "complete"] : ["complete"],
    operatorStates: entry.expectedOutcome === "alert" ? ["alert", "recovering"] : ["checking"],
    result: "PASS",
  }));
  const report = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-packaged-end-to-end-result",
    campaignId: manifest.campaignId,
    manifestHash: sha256(manifestContents),
    release: { before: boundIdentity.release, after: boundIdentity.release, unchanged: true },
    runtime: { executable: "/usr/bin/node", packaged: true, simulation: true, physicalReceiver: "not-run" },
    qualificationIdentity: boundIdentity,
    runtimeIdentity: { before: runtimeBinding(boundIdentity), after: runtimeBinding(boundIdentity), unchanged: true },
    loadedQualificationIdentity: { before: boundIdentity, after: boundIdentity, unchanged: true },
    cases,
    evidence: { attribution: { oldFrequencyMisattribution: 0, syntheticFramesPersisted: 7 } },
    isolation: { executionDomain: "test", fieldUnchanged: true, testChanged: true },
    result: { packagedEndToEndSubGate: "passed", overallV4: "not-passed", productionReady: false },
    downstreamGates: { V5: "not-run", V6: "not-run", V7: "not-run" },
  };
  await Promise.all([
    writeFile(path.join(root, "manifest.json"), manifestContents),
    writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
  ]);
  await writeChecksums(root, ["manifest.json", "report.json"]);
}

async function createDetectorBundle(root: string, overrides: Partial<V4CombinedIdentity> = {}): Promise<void> {
  const detectorIdentity = { ...identity, ...overrides, release: overrides.release ?? identity.release };
  await mkdir(path.join(root, "results"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-detector-campaign",
    campaignId: "detector-fixture",
    overallV4Eligible: false,
    release: detectorIdentity.release,
    frozen: {
      targetIds,
      catalogVersion: detectorIdentity.catalogVersion,
      catalogHash: detectorIdentity.catalogSha256,
      detectorRuleSetId: detectorIdentity.detectorRuleSetId,
      detectorRuleHash: detectorIdentity.detectorRuleSha256,
    },
    counts: { deterministic: 40, randomized: 16_000, total: 16_040 },
    protocol: { deterministicRunsPerTargetFamily: 1, randomizedRunsPerTargetFamily: 400 },
  };
  const report = {
    schemaVersion: 1,
    recordType: "rf-monitor-v4-detector-campaign-result",
    campaignId: manifest.campaignId,
    executedCases: 16_040,
    truthCommitmentsVerified: 16_040,
    candidate: { before: detectorIdentity.release, after: detectorIdentity.release, unchanged: true, runtimeMatches: true },
    isolation: { executionDomain: "test", fieldWritesReported: 0, unchanged: true },
    result: { detectorStatisticalSubGate: "passed", overallV4: "not-passed", productionReady: false },
    downstreamGates: { V5: "not-run", V6: "not-run" },
  };
  await Promise.all([
    writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(root, "results", "chunk-000000.json"), "{}\n"),
  ]);
  await writeChecksums(root, ["manifest.json", "report.json", "results/chunk-000000.json"]);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v4-combine-"));
  temporaryRoots.push(root);
  const packaged = path.join(root, "packaged");
  const detector = path.join(root, "detector");
  const output = path.join(root, "output");
  await Promise.all([createPackagedBundle(packaged), createDetectorBundle(detector)]);
  return { root, packaged, detector, output };
}

const fakeDetectorVerifier = async () => ({ files: 4, valid: true as const });

describe("V4 overall combiner", () => {
  it("parses help and rejects unknown commands, options, duplicates, and missing inputs", () => {
    expect(parseV4CombineArguments(["--help"])).toEqual({ command: "help" });
    expect(V4_COMBINE_HELP).toMatch(/synthetic software evidence/);
    expect(() => parseV4CombineArguments([])).toThrow(/command is required/);
    expect(() => parseV4CombineArguments(["launch"])).toThrow(/Unknown/);
    expect(() => parseV4CombineArguments(["verify", "--other", "x"])).toThrow(/Unknown/);
    expect(() => parseV4CombineArguments(["verify"])).toThrow(/requires --bundle/);
    expect(() => parseV4CombineArguments(["combine", "--packaged-bundle", "a", "--packaged-bundle", "b", "--detector-bundle", "c"])).toThrow(/Duplicate/);
  });

  it("publishes one immutable, checksum-complete PASS while keeping live gates not run", async () => {
    const paths = await fixture();
    const result = await combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "v4-combined-fixture",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    });
    expect(result.verification).toMatchObject({ valid: true, gateDecision: "passed", productionReady: false });
    const report = JSON.parse(await readFile(path.join(result.bundlePath, "report.json"), "utf8"));
    expect(report).toMatchObject({
      detectorCases: 16_040,
      sourceBundlesUnchanged: true,
      releaseUnchanged: true,
      result: { gateDecision: "passed", softwareQualificationOnly: true, productionReady: false, V5: "not-run", V6: "not-run", V7: "not-run" },
    });
    expect(report.limitations.join(" ")).toMatch(/live field-domain V5, V6.*24-hour V7/);
    expect((await stat(path.join(result.bundlePath, "report.json"))).mode & 0o222).toBe(0);
    await expect(verifyV4CombinedBundle(result.bundlePath, { verifyDetectorBundle: fakeDetectorVerifier, expectedIdentity: identity }))
      .resolves.toMatchObject({ valid: true });

    await expect(combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "v4-combined-fixture",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    })).rejects.toThrow(/will not be overwritten/);
    expect(JSON.parse(await readFile(path.join(result.bundlePath, "report.json"), "utf8"))).toEqual(report);
  });

  it("rejects legacy packaged artifacts without the exact loaded configuration binding", async () => {
    const paths = await fixture();
    const manifestPath = path.join(paths.packaged, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.identity;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeChecksums(paths.packaged, ["manifest.json", "report.json"]);
    await expect(verifyPassingV4PackagedBundle(paths.packaged)).rejects.toThrow(/packaged-config-binding-missing/);
  });

  it("rejects unexpected files and linked artifacts before publication", async () => {
    const unexpected = await fixture();
    await writeFile(path.join(unexpected.packaged, "extra.json"), "{}\n");
    await expect(combineV4Qualification({
      packagedBundle: unexpected.packaged,
      detectorBundle: unexpected.detector,
      outputRoot: unexpected.output,
      resultId: "unexpected-file",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    })).rejects.toThrow(/file-count|missing or unexpected/);

    const linked = await fixture();
    await symlink(path.join(linked.detector, "report.json"), path.join(linked.detector, "results", "linked.json"));
    await expect(combineV4Qualification({
      packagedBundle: linked.packaged,
      detectorBundle: linked.detector,
      outputRoot: linked.output,
      resultId: "linked-artifact",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    })).rejects.toThrow(/symlink/);
  });

  it("rejects candidate, client, catalog, detector, and operational-configuration mismatches", async () => {
    const mismatches: Array<[string, Partial<V4CombinedIdentity>]> = [
      ["candidate", { release: { ...release, packageDigest: "a".repeat(64) } }],
      ["client", { clientBuildId: "other-client" }],
      ["catalog", { catalogSha256: "b".repeat(64) }],
      ["detector", { detectorRuleSha256: "c".repeat(64) }],
      ["configuration", { configurationSha256: "d".repeat(64) }],
    ];
    for (const [name, mismatch] of mismatches) {
      const paths = await fixture();
      const current = { ...identity, ...mismatch } as V4CombinedIdentity;
      await expect(combineV4Qualification({
        packagedBundle: paths.packaged,
        detectorBundle: paths.detector,
        outputRoot: paths.output,
        resultId: `mismatch-${name}`,
        dependencies: { readCurrentIdentity: async () => current, verifyDetectorBundle: fakeDetectorVerifier },
      })).rejects.toThrow();
    }
  });

  it("rejects sub-gates that bind different detector/catalog identities", async () => {
    const paths = await fixture();
    await makeWritable(paths.detector);
    await rm(paths.detector, { recursive: true, force: true });
    await createDetectorBundle(paths.detector, { detectorRuleSha256: "f".repeat(64) });
    await expect(combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "detector-mismatch",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    })).rejects.toThrow(/detector identity/);
  });

  it("fails closed if the candidate/configuration drifts before publication", async () => {
    const paths = await fixture();
    let reads = 0;
    await expect(combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "source-drift",
      dependencies: {
        readCurrentIdentity: async () => (++reads >= 3 ? { ...identity, configurationSha256: "e".repeat(64) } : identity),
        verifyDetectorBundle: fakeDetectorVerifier,
      },
    })).rejects.toThrow(/drift occurred before publication/);
    await expect(readFile(path.join(paths.output, "source-drift", "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects post-publication tampering through exact outer checksum coverage", async () => {
    const paths = await fixture();
    const result = await combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "tamper-check",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    });
    const nestedReport = path.join(result.bundlePath, "subgates", "detector", "report.json");
    await chmod(nestedReport, 0o640);
    await writeFile(nestedReport, "{}\n");
    await expect(verifyV4CombinedBundle(result.bundlePath, { verifyDetectorBundle: fakeDetectorVerifier })).rejects.toThrow(/hash mismatch/);
  });

  it("rejects a self-consistently rehashed production-ready forgery", async () => {
    const paths = await fixture();
    const result = await combineV4Qualification({
      packagedBundle: paths.packaged,
      detectorBundle: paths.detector,
      outputRoot: paths.output,
      resultId: "semantic-forgery",
      dependencies: { readCurrentIdentity: async () => identity, verifyDetectorBundle: fakeDetectorVerifier },
    });
    await makeWritable(result.bundlePath);
    const reportPath = path.join(result.bundlePath, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.result.productionReady = true;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await refreshExistingChecksums(result.bundlePath);
    await expect(verifyV4CombinedBundle(result.bundlePath, { verifyDetectorBundle: fakeDetectorVerifier })).rejects.toThrow(/decision is not fail-closed/);
  });
});
