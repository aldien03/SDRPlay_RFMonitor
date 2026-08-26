import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertV2CandidateUnchanged,
  createV2SandboxCleanup,
  parseV2Arguments,
  publishV2QualificationBundle,
  verifyV2QualificationBundle,
} from "../scripts/run-v2-process-storage-qualification.mjs";

const temporaryRoots: string[] = [];

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o750).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeWritable(path.join(directory, entry.name))));
  await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => chmod(path.join(directory, entry.name), 0o640).catch(() => undefined)));
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

function identity(seed = "1") {
  return {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: "1.0.0",
    buildId: "1.0.0+runner-test",
    sourceDigest: seed.repeat(64),
    packageDigest: "2".repeat(64),
    dependencyLockDigest: "3".repeat(64),
  };
}

const faultPoints = [
  "frame-after-raw-append",
  "frame-after-index-append",
  "rotation-after-finalizing-checkpoint",
  "rotation-after-next-session",
  "finalization-rename",
  "finalization-fsync",
];

function bundleValues() {
  const release = identity();
  const scenarios = faultPoints.map((faultPoint) => ({
    faultPoint,
    result: "PASS",
    trustDomains: { active: "field", unchanged: true },
  }));
  const record = {
    schemaVersion: 1,
    gate: "V2",
    result: "PASS",
    softwareQualificationOnly: true,
    productionQualified: false,
    release,
    candidateIdentity: { before: release, after: release, unchanged: true },
    scenarios,
  };
  return {
    record,
    summary: {
      schemaVersion: 1,
      gate: "V2",
      result: "PASS",
      buildId: release.buildId,
      scenarioCount: scenarios.length,
      output: "artifacts/validation/v2/test",
    },
  };
}

describe("V2 qualification runner boundaries", () => {
  it("shows help without starting qualification and rejects unknown or ambiguous arguments", () => {
    expect(parseV2Arguments(["--help"])).toMatchObject({ help: true });
    expect(parseV2Arguments(["--output", "/tmp/result", "--keep-temp"])).toMatchObject({ output: "/tmp/result", keepTemp: true });
    expect(() => parseV2Arguments(["--unknown"])).toThrow(/Unknown argument/);
    expect(() => parseV2Arguments(["--output"])).toThrow(/requires a value/);
    expect(() => parseV2Arguments(["--verify-bundle", "/tmp/result", "--keep-temp"])).toThrow(/cannot be combined/);

    const script = path.resolve("scripts/run-v2-process-storage-qualification.mjs");
    const help = spawnSync("/usr/bin/node", [script, "--help"], { encoding: "utf8" });
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("--verify-bundle DIRECTORY");
    const unknown = spawnSync("/usr/bin/node", [script, "--unknown"], { encoding: "utf8" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown argument: --unknown");
  });

  it("fails closed when any exact candidate identity changes between the pre- and post-run checks", () => {
    expect(assertV2CandidateUnchanged(identity(), identity())).toBe(true);
    expect(() => assertV2CandidateUnchanged(identity(), identity("9"))).toThrow(/sourceDigest/);
    expect(() => assertV2CandidateUnchanged(identity(), { ...identity(), buildId: "1.0.0+changed" })).toThrow(/buildId/);
  });

  it("publishes an immutable exact bundle and mechanically detects tampering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v2-bundle-"));
    temporaryRoots.push(root);
    const destination = path.join(root, "candidate");
    const values = bundleValues();
    await expect(publishV2QualificationBundle({ outputDirectory: destination, ...values })).resolves.toBe(destination);
    await expect(verifyV2QualificationBundle(destination)).resolves.toMatchObject({ valid: true, result: "PASS", buildId: identity().buildId });
    const qualification = JSON.parse(await readFile(path.join(destination, "qualification.json"), "utf8"));
    expect(Object.keys(qualification.release)).toEqual(["schemaVersion", "product", "releaseVersion", "buildId", "sourceDigest", "packageDigest", "dependencyLockDigest"]);
    expect((await stat(destination)).mode & 0o777).toBe(0o550);
    expect((await stat(path.join(destination, "qualification.json"))).mode & 0o777).toBe(0o440);
    expect((await readdir(destination)).sort()).toEqual(["SHA256SUMS", "qualification.json", "summary.json"]);
    await expect(publishV2QualificationBundle({ outputDirectory: destination, ...values })).rejects.toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTEMPTY/) });

    await chmod(path.join(destination, "qualification.json"), 0o640);
    const record = JSON.parse(await readFile(path.join(destination, "qualification.json"), "utf8"));
    await writeFile(path.join(destination, "qualification.json"), `${JSON.stringify({ ...record, result: "FAIL" })}\n`);
    await chmod(path.join(destination, "qualification.json"), 0o440);
    await expect(verifyV2QualificationBundle(destination)).rejects.toThrow(/checksum mismatch/);
  });

  it("uses an idempotent interruption cleanup confined to the temporary root", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-v2-cleanup-"));
    let stops = 0;
    const cleanup = createV2SandboxCleanup({ sandbox, keepTemp: false, stopRuntime: async () => { stops += 1; } });
    await Promise.all([cleanup(), cleanup()]);
    expect(stops).toBe(1);
    await expect(stat(sandbox)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => createV2SandboxCleanup({ sandbox: path.resolve("not-temporary"), keepTemp: false, stopRuntime: async () => undefined })).toThrow(/outside the temporary root/);
  });
});
