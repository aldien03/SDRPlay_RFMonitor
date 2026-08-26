import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateReleaseMetadata } from "../scripts/generate-release-metadata.mjs";
import { createRuntimeIdentity, loadReleaseIdentity, withIdentityConfiguration } from "../src/server/releaseIdentity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-release-identity-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "src", "server"), { recursive: true }),
    mkdir(path.join(root, "scripts"), { recursive: true }),
    mkdir(path.join(root, "worker"), { recursive: true }),
    mkdir(path.join(root, "config"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "rf-monitor", version: "1.2.3" })),
    writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 })),
    writeFile(path.join(root, "src", "server", "index.ts"), "export const value = 1;\n"),
    writeFile(path.join(root, "scripts", "build.mjs"), "export {};\n"),
  ]);
  return root;
}

describe("immutable release identity", () => {
  it("derives stable diagnostic identity but does not qualify it as release metadata", async () => {
    const root = await fixtureRoot();
    const first = await loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment: {} });
    const second = await loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment: {} });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ releaseVersion: "1.2.3", integrity: "runtime-derived" });
    expect(first.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.packageDigest).toBe(first.sourceDigest);
    expect(first.dependencyLockDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts complete matching release metadata and rejects a digest mismatch", async () => {
    const root = await fixtureRoot();
    const derived = await loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment: {} });
    const environment = {
      RF_MONITOR_BUILD_ID: "release-1.2.3-test",
      RF_MONITOR_SOURCE_DIGEST: derived.sourceDigest,
      RF_MONITOR_PACKAGE_DIGEST: derived.packageDigest,
      RF_MONITOR_DEPENDENCY_LOCK_DIGEST: derived.dependencyLockDigest,
    };
    await expect(loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment }))
      .resolves.toMatchObject({ buildId: "release-1.2.3-test", integrity: "release-metadata" });
    await writeFile(path.join(root, "src", "server", "index.ts"), "export const value = 2;\n");
    await expect(loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment }))
      .rejects.toThrow(/do not match the installed package/);
  });

  it("uses the centralized source/package roots and accepts its generated packaged identity", async () => {
    const root = await fixtureRoot();
    await Promise.all([
      mkdir(path.join(root, "tests"), { recursive: true }),
      mkdir(path.join(root, "deploy"), { recursive: true }),
      mkdir(path.join(root, "docs"), { recursive: true }),
      mkdir(path.join(root, "dist/client"), { recursive: true }),
      mkdir(path.join(root, "dist/server"), { recursive: true }),
      mkdir(path.join(root, "dist/server-node"), { recursive: true }),
      mkdir(path.join(root, "dist/.openai"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "tests/identity.test.ts"), "// release-bound test input\n"),
      writeFile(path.join(root, "deploy/unit.template"), "# deployment input\n"),
      writeFile(path.join(root, "docs/readme.md"), "# release\n"),
      writeFile(path.join(root, "tsconfig.json"), "{}\n"),
      writeFile(path.join(root, "vite.config.mjs"), "export default {};\n"),
      writeFile(path.join(root, "vitest.config.ts"), "export default {};\n"),
      writeFile(path.join(root, "dist/client/index.html"), "<!doctype html><html><head></head><body></body></html>\n"),
      writeFile(path.join(root, "dist/server/index.js"), "export {};\n"),
      writeFile(path.join(root, "dist/server-node/index.js"), "export {};\n"),
      writeFile(path.join(root, "dist/.openai/hosting.json"), "{}\n"),
    ]);
    const metadata = await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
    await expect(loadReleaseIdentity({
      repositoryRoot: root,
      executablePath: path.join(root, "dist/server-node/index.js"),
      environment: {},
    })).resolves.toMatchObject({
      buildId: metadata.buildId,
      sourceDigest: metadata.sourceDigest,
      packageDigest: metadata.packageDigest,
      integrity: "release-metadata",
    });
  });

  it("[trace:REL-010] keeps one service boot identity while changing only versioned configuration context", async () => {
    const root = await fixtureRoot();
    const release = await loadReleaseIdentity({ repositoryRoot: root, executablePath: path.join(root, "src/server/index.ts"), environment: {} });
    const first = createRuntimeIdentity(release, {
      catalogVersion: "catalog-v3",
      configurationHash: "a".repeat(64),
      configurationRevision: 1,
      detectorRuleSetId: "rf-relative-mad-v1",
      expectedSampleRateHz: 10_000_000,
    });
    const next = withIdentityConfiguration(first, {
      ...first.configuration,
      configurationHash: "b".repeat(64),
      configurationRevision: 2,
    });
    expect(next.serviceBootId).toBe(first.serviceBootId);
    expect(next.release).toBe(first.release);
    expect(next.configuration).toMatchObject({ configurationRevision: 2, configurationHash: "b".repeat(64) });
  });
});
