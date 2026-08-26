import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  V1_COMMANDS,
  createV1ValidationRecord,
  parseV1Arguments,
  parseVitestSummary,
  publishV1Bundle,
  runV1Validation,
  sha256,
  validateV1PublicationCandidate,
} from "../scripts/generate-v1-validation-record.mjs";

const temporaryRoots: string[] = [];

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o750).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeWritable(path.join(directory, entry.name))));
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

function release() {
  return {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: "1.0.0",
    buildId: "release-test",
    sourceDigest: "1".repeat(64),
    packageDigest: "2".repeat(64),
    dependencyLockDigest: "3".repeat(64),
  };
}

function vitestJson(overrides: Record<string, number> = {}): string {
  const counts = {
    numTotalTestSuites: 40,
    numPassedTestSuites: 40,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 300,
    numPassedTests: 300,
    numFailedTests: 0,
    numPendingTests: 0,
    ...overrides,
  };
  const failedFiles = Math.min(counts.numFailedTestSuites, counts.numTotalTestSuites);
  const pendingFiles = Math.min(counts.numPendingTestSuites, counts.numTotalTestSuites - failedFiles);
  const passedFiles = counts.numTotalTestSuites - failedFiles - pendingFiles;
  return JSON.stringify({
    ...counts,
    testResults: [
      ...Array.from({ length: passedFiles }, (_, index) => ({ name: `passed-${index}.test.ts`, status: "passed" })),
      ...Array.from({ length: failedFiles }, (_, index) => ({ name: `failed-${index}.test.ts`, status: "failed" })),
      ...Array.from({ length: pendingFiles }, (_, index) => ({ name: `pending-${index}.test.ts`, status: "pending" })),
    ],
  });
}

function results(unitOutput = vitestJson()) {
  return V1_COMMANDS.map((command, index) => ({
    ...command,
    startedAt: `2026-08-23T12:00:0${index}.000Z`,
    completedAt: `2026-08-23T12:00:0${index}.100Z`,
    durationMs: 100,
    exitCode: 0,
    signal: null,
    stdout: command.id === "unit" ? unitOutput : Buffer.from(`${command.id} passed\n`),
    stderr: Buffer.alloc(0),
  }));
}

describe("mechanical V1 validation record", () => {
  it("shows CLI help without running V1 and rejects every unknown argument", () => {
    expect(parseV1Arguments(["--help"])).toEqual({ help: true });
    expect(() => parseV1Arguments(["--bogus"])).toThrow(/Unknown argument/);
    const script = path.resolve("scripts/generate-v1-validation-record.mjs");
    const help = spawnSync("/usr/bin/node", [script, "--help"], { encoding: "utf8" });
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: npm run validate:v1");
    const unknown = spawnSync("/usr/bin/node", [script, "--bogus"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown argument: --bogus");
  });

  it("detects a final release-identity race and never reaches publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-v1-race-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "release.json"), `${JSON.stringify(release())}\n`);
    await expect(validateV1PublicationCandidate({
      repositoryRoot: root,
      validatePackage: async () => {
        const validated = release();
        await writeFile(path.join(root, "dist", "release.json"), `${JSON.stringify({ ...validated, sourceDigest: "9".repeat(64) })}\n`);
        return { valid: true, ...validated, clientBuildId: validated.buildId };
      },
    })).rejects.toThrow(/changed while validating sourceDigest/);

    let published = false;
    await expect(runV1Validation({
      repositoryRoot: root,
      execute: async (command: (typeof V1_COMMANDS)[number]) => results().find((result) => result.id === command.id),
      validatePublicationCandidate: async () => { throw new Error("concurrent source edit"); },
      publish: async () => { published = true; return "must-not-publish"; },
    })).rejects.toThrow(/concurrent source edit/);
    expect(published).toBe(false);
  });

  it("records exact test counts, commands, hashes, Node/OS, and software-only scope", () => {
    const commandResults = results();
    const record = createV1ValidationRecord({
      release: release(),
      commandResults,
      generatedAt: "2026-08-23T12:30:00.000Z",
      environment: {
        nodeVersion: "v24.19.0",
        nodeExecutable: "/usr/bin/node",
        osPlatform: "linux",
        osRelease: "test-kernel",
        architecture: "x64",
        logicalCpuCount: 8,
      },
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      gate: "V1",
      environment: { nodeVersion: "v24.19.0", nodeExecutable: "/usr/bin/node", osPlatform: "linux" },
      result: { state: "passed", softwareGatePassed: true, productionReady: false, physicalQualification: "not-run" },
      testSummary: { testFiles: 40, passedTestFiles: 40, suites: 40, passedSuites: 40, tests: 300, passedTests: 300, failedTests: 0, skippedTests: 0 },
      hashes: { source: "1".repeat(64), package: "2".repeat(64), dependencyLock: "3".repeat(64) },
      gateStatus: { V0: "passed", V1: "passed", V6: "not-run", V7: "not-run" },
    });
    expect(record.commands).toHaveLength(V1_COMMANDS.length);
    expect(Object.keys(record.gateStatus)).toEqual(["V0", "V1", "V2", "V3", "V4", "V5", "V6", "V7"]);
    expect(record.commands.find((entry: { id: string }) => entry.id === "unit")).toMatchObject({
      command: "/usr/bin/npm",
      stdoutSha256: sha256(commandResults.find((entry) => entry.id === "unit")!.stdout),
    });
  });

  it("fails V1 when a test is skipped without making any physical qualification claim", () => {
    const record = createV1ValidationRecord({
      release: release(),
      commandResults: results(vitestJson({ numPassedTests: 299, numPendingTests: 1 })),
    });
    expect(record.result).toEqual({
      state: "failed",
      softwareGatePassed: false,
      productionReady: false,
      physicalQualification: "not-run",
    });
    expect(record.gateStatus).toMatchObject({ V0: "failed", V1: "failed", V6: "not-run", V7: "not-run" });
  });

  it("does not mislabel nested Vitest suites as test files", () => {
    const summary = parseVitestSummary(JSON.stringify({
      numTotalTestSuites: 109,
      numPassedTestSuites: 109,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 378,
      numPassedTests: 378,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: Array.from({ length: 46 }, (_, index) => ({ name: `file-${index}.test.ts`, status: "passed" })),
    }));
    expect(summary).toMatchObject({
      testFiles: 46,
      passedTestFiles: 46,
      suites: 109,
      passedSuites: 109,
      tests: 378,
    });
  });

  it("publishes one read-only, hash-verifiable bundle and refuses to overwrite it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-v1-record-"));
    temporaryRoots.push(root);
    const commandResults = results();
    const record = createV1ValidationRecord({ release: release(), commandResults });
    const destination = await publishV1Bundle({ outputRoot: root, bundleName: "candidate-release-test", record, commandResults });

    expect((await stat(destination)).mode & 0o777).toBe(0o550);
    expect((await stat(path.join(destination, "record.json"))).mode & 0o777).toBe(0o440);
    expect(JSON.parse(await readFile(path.join(destination, "record.json"), "utf8"))).toEqual(record);
    const sums = await readFile(path.join(destination, "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${sha256(await readFile(path.join(destination, "record.json")))}  record.json`);
    expect(sums).toContain("commands/unit.stdout");

    await expect(publishV1Bundle({ outputRoot: root, bundleName: "candidate-release-test", record, commandResults }))
      .rejects.toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTEMPTY/) });
    expect((await readdir(root)).filter((entry) => entry.startsWith(".partial-"))).toEqual([]);
  // Concurrent evidence-bundle tests can briefly serialize fsync-heavy writes
  // on slower deployment disks. Keep the operation bounded without making the
  // full-suite result depend on an unrealistically short filesystem deadline.
  }, 60_000);

  it("rejects malformed test summaries instead of inventing counts", () => {
    expect(() => parseVitestSummary("not JSON")).toThrow(/summary is missing/);
    expect(() => parseVitestSummary(vitestJson({ numTotalTests: -1 }))).toThrow(/non-negative integer/);
    expect(() => parseVitestSummary(JSON.stringify({
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
    }))).toThrow(/per-file results/);
  });
});
