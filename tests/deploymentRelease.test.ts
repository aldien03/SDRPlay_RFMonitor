import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateReleaseMetadata } from "../scripts/generate-release-metadata.mjs";
import { evaluateDeploymentHealth, evaluateOperationsConfiguration, runCommand } from "../deploy/release-cli.mjs";
import {
  AUXILIARY_UNIT_SPECS,
  activateRelease,
  normalizeDeploymentLayout,
  renderApplicationUnit,
  rollbackRelease,
  restoreLegacyRelease,
  sha256,
  stageRelease,
  validateDeploymentPreflight,
  verifyInstalledRelease,
} from "../deploy/release-manager.mjs";

const TEMPORARY_ROOTS: string[] = [];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  for (const root of TEMPORARY_ROOTS.splice(0)) {
    await chmod(root, 0o755).catch(() => undefined);
    const pending = [root];
    while (pending.length) {
      const current = pending.pop()!;
      const details = await lstat(current).catch(() => undefined);
      if (!details) continue;
      if (details.isSymbolicLink()) {
        await rm(current, { force: true });
      } else if (details.isDirectory()) {
        await chmod(current, 0o755).catch(() => undefined);
        for (const entry of await readdir(current).catch(() => [])) pending.push(path.join(current, entry));
      } else await chmod(current, 0o644).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rf-monitor-deployment-"));
  TEMPORARY_ROOTS.push(root);
  return root;
}

async function sourceFixture(parent: string, version: string, marker: string): Promise<string> {
  const root = path.join(parent, `source-${marker}`);
  for (const directory of [
    "src", "tests", "scripts", "config", "deploy", "docs", "dist/client", "dist/server", "dist/server-node", "dist/.openai",
  ]) await mkdir(path.join(root, directory), { recursive: true });
  const unit = `[Unit]\nDescription=RF Monitor fixture ${marker}\n[Service]\nUser=@@SERVICE_USER@@\nGroup=@@SERVICE_GROUP@@\nWorkingDirectory=@@INSTALL_DIR@@\nEnvironmentFile=@@CONFIG_FILE@@\nExecStart=@@NODE_BIN@@ --max-old-space-size=384 @@INSTALL_DIR@@/dist/server-node/index.js\nMemoryHigh=512M\nMemoryMax=768M\nTasksMax=128\nLimitNOFILE=8192\nNoNewPrivileges=true\nReadWritePaths=@@STORAGE_DIR@@ @@RUNTIME_CONFIG_DIR@@\n`;
  await Promise.all([
    writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "rf-monitor", version, private: true, type: "module" })}\n`),
    writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "rf-monitor", version, lockfileVersion: 3, packages: { "": { name: "rf-monitor", version } } })}\n`),
    writeFile(path.join(root, "src/marker.ts"), `export const marker = ${JSON.stringify(marker)};\n`),
    writeFile(path.join(root, "tests/marker.test.ts"), `// tested source ${marker}\n`),
    writeFile(path.join(root, "scripts/build.mjs"), `// build ${marker}\n`),
    writeFile(path.join(root, "config/catalog.json"), `${JSON.stringify({ version: marker })}\n`),
    writeFile(path.join(root, "docs/release.md"), `# ${marker}\n`),
    writeFile(path.join(root, "deploy/rf-monitor.service.template"), unit),
    writeFile(path.join(root, "dist/client/index.html"), "<!doctype html><html><head></head><body></body></html>\n"),
    writeFile(path.join(root, "dist/server/index.js"), `export const marker=${JSON.stringify(marker)};\n`),
    writeFile(path.join(root, "dist/server-node/index.js"), `console.log(${JSON.stringify(marker)});\n`),
    writeFile(path.join(root, "dist/server-node/evidence-backup.js"), "// fixture backup entry point\n"),
    writeFile(path.join(root, "dist/server-node/evidence-verifier.js"), "// fixture verifier entry point\n"),
    writeFile(path.join(root, "dist/.openai/hosting.json"), "{}\n"),
    writeFile(path.join(root, "README.md"), `RF Monitor ${marker}\n`),
    writeFile(path.join(root, "install.sh"), "#!/usr/bin/env bash\nexit 0\n"),
    writeFile(path.join(root, "tsconfig.json"), "{}\n"),
    writeFile(path.join(root, "vite.config.mjs"), "export default {};\n"),
    writeFile(path.join(root, "vitest.config.ts"), "export default {};\n"),
  ]);
  const deployFiles = [...new Set([
    ...AUXILIARY_UNIT_SPECS.map((specification) => specification.source),
    "deploy/rf-monitor-backup.sh",
    "deploy/ops-supervisor.mjs",
    "deploy/recover-application.sh",
    "deploy/recover-sdrconnect.sh",
    "deploy/verify-recovery-supervisor.sh",
  ])];
  await Promise.all(deployFiles.map((relative) => copyFile(path.join(REPOSITORY_ROOT, relative), path.join(root, relative))));
  await generateReleaseMetadata({ repositoryRoot: root, environment: {} });
  return root;
}

async function deploymentFixture() {
  const root = await fixtureRoot();
  const installRoot = path.join(root, "opt/rf-monitor");
  const configFile = path.join(root, "etc/rf-monitor.env");
  const storageDirectory = path.join(root, "var/lib/rf-monitor/evidence");
  const runtimeConfigDirectory = path.join(root, "var/lib/rf-monitor/config");
  const unitPath = path.join(root, "etc/systemd/system/rf-monitor.service");
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(path.dirname(configFile), { recursive: true }),
    mkdir(storageDirectory, { recursive: true }),
    mkdir(runtimeConfigDirectory, { recursive: true }),
    mkdir(path.dirname(unitPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(configFile, "RF_MONITOR_SIMULATION=off\n"),
    writeFile(path.join(storageDirectory, "evidence.keep"), "field evidence\n"),
    writeFile(path.join(runtimeConfigDirectory, "operational.json"), "{\"revision\":7}\n"),
  ]);
  return {
    root,
    layout: normalizeDeploymentLayout({ installRoot, configFile, storageDirectory, runtimeConfigDirectory, unitPath, nodeBinary: "/usr/bin/node" }),
  };
}

function stageHooks(overrides: { mutateLock?: boolean; auditPassed?: boolean; dependencySymlink?: "safe" | "external"; externalTarget?: string } = {}) {
  let installs = 0;
  return {
    get installs() { return installs; },
    async installDependencies(directory: string, specification: { executable: string; arguments: string[] }) {
      installs += 1;
      expect(specification).toEqual({
        executable: "/usr/bin/npm",
        arguments: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--fund=false"],
      });
      await mkdir(path.join(directory, "node_modules/production-only"), { recursive: true });
      await writeFile(path.join(directory, "node_modules/production-only/package.json"), "{}\n");
      if (overrides.dependencySymlink) {
        await mkdir(path.join(directory, "node_modules/.bin"), { recursive: true });
        await writeFile(path.join(directory, "node_modules/production-only/tool.js"), "#!/usr/bin/env node\n");
        await symlink(
          overrides.dependencySymlink === "safe" ? "../production-only/tool.js" : overrides.externalTarget!,
          path.join(directory, "node_modules/.bin/production-tool"),
        );
      }
      if (overrides.mutateLock) await writeFile(path.join(directory, "package-lock.json"), "tampered\n");
    },
    async generateSupplyChain(_directory: string, release: { buildId: string }) {
      return {
        sbom: { spdxVersion: "SPDX-2.3", name: release.buildId },
        audit: { auditReportVersion: 2, metadata: { vulnerabilities: { total: overrides.auditPassed === false ? 1 : 0 } } },
        auditPassed: overrides.auditPassed !== false,
      };
    },
  };
}

const GOOD_PREFLIGHT = {
  schemaVersion: 1,
  checkedAt: "2026-08-23T14:00:00.000Z",
  checks: {
    systemNode: true,
    lockfileInstall: true,
    diskReserve: true,
    clockSynchronized: true,
    tlsCertificate: true,
    tlsKeyMatch: true,
    nginxConfiguration: true,
    nginxActive: true,
    firewallActive: true,
    backendPortDenied: true,
    sdrconnectPortDenied: true,
    operationsConfig: true,
    restoreStaging: true,
  },
  values: { offHostBackupConfigured: false },
  remotePortReachability: "not-run-external",
} as const;

function activationHooks(layout: ReturnType<typeof normalizeDeploymentLayout>, state: {
  failedHealthBuilds?: Set<string>;
  mismatchedUnitBuilds?: Set<string>;
  mismatchedAuxiliaryBuilds?: Set<string>;
  failedTimerBuilds?: Set<string>;
  failedLegacyHealth?: boolean;
  preflight?: typeof GOOD_PREFLIGHT | Record<string, unknown>;
} = {}) {
  let unit = "";
  let auxiliaryUnits: Array<{ name: string; unitPath: string; contents: string; sha256: string; kind: string }> = [];
  let stopped = false;
  let restartCount = 0;
  let timerQuiesced = false;
  let timerWindowViolations = 0;
  const timerRuntime = new Map<string, { enabled: boolean; active: boolean }>();
  const events: string[] = [];
  const assertTimerQuiesced = (boundary: string) => {
    if (!timerQuiesced || [...timerRuntime.values()].some((runtime) => runtime.active)) {
      timerWindowViolations += 1;
      throw new Error(`fixture timer action could occur during ${boundary}`);
    }
    events.push(boundary);
  };
  const activeBuild = async () => {
    const target = path.resolve(path.dirname(layout.activeLink), await readlink(layout.activeLink));
    return JSON.parse(await readFile(path.join(target, "dist/release.json"), "utf8")).buildId as string;
  };
  return {
    get stopped() { return stopped; },
    get restartCount() { return restartCount; },
    get timerWindowViolations() { return timerWindowViolations; },
    get events() { return [...events]; },
    get timerStates() { return Object.fromEntries(timerRuntime); },
    setTimerState(name: string, runtime: { enabled: boolean; active: boolean }) { timerRuntime.set(name, runtime); },
    async preflight() { return state.preflight ?? GOOD_PREFLIGHT; },
    async installUnit(unitPath: string, contents: string) {
      assertTimerQuiesced("install-application-unit");
      unit = contents;
      await writeFile(unitPath, contents);
    },
    async installAuxiliaryUnits(units: typeof auxiliaryUnits) {
      assertTimerQuiesced("install-auxiliary-units");
      auxiliaryUnits = units;
      for (const candidate of units) await writeFile(candidate.unitPath, candidate.contents);
    },
    async captureLegacyUnits(input: { auxiliaryUnits: typeof auxiliaryUnits; expectedMainUnitSha256: string }) {
      const mainContents = await readFile(layout.unitPath, "utf8");
      expect(sha256(mainContents)).toBe(input.expectedMainUnitSha256);
      return {
        mainUnit: { unitPath: layout.unitPath, contents: mainContents, sha256: sha256(mainContents) },
        auxiliaryUnits: await Promise.all(input.auxiliaryUnits.map(async (candidate) => {
          const contents = await readFile(candidate.unitPath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          return {
            name: candidate.name,
            unitPath: candidate.unitPath,
            existed: contents !== undefined,
            ...(contents === undefined ? {} : { contents, sha256: sha256(contents) }),
          };
        })),
      };
    },
    async restoreLegacyUnits(bundle: { mainUnit: { unitPath: string; contents: string }; auxiliaryUnits: Array<{ unitPath: string; existed: boolean; contents?: string }> }) {
      assertTimerQuiesced("restore-legacy-units");
      unit = bundle.mainUnit.contents;
      await writeFile(bundle.mainUnit.unitPath, bundle.mainUnit.contents);
      for (const candidate of bundle.auxiliaryUnits) {
        if (candidate.existed) await writeFile(candidate.unitPath, candidate.contents!);
        else await rm(candidate.unitPath, { force: true });
      }
    },
    async daemonReload() { assertTimerQuiesced("daemon-reload"); },
    async removeUnit(unitPath: string) { await rm(unitPath, { force: true }); },
    async removeAuxiliaryUnits(units: typeof auxiliaryUnits) {
      for (const candidate of units) await rm(candidate.unitPath, { force: true });
      auxiliaryUnits = [];
    },
    async loadedUnit() {
      assertTimerQuiesced("verify-application-unit");
      const buildId = await activeBuild();
      return {
        loadState: "loaded",
        needDaemonReload: "no",
        dropInPaths: "",
        fragmentPath: layout.unitPath,
        workingDirectory: layout.activeLink,
        execStart: `${layout.nodeBinary} --max-old-space-size=384 ${layout.activeLink}/dist/server-node/index.js`,
        environmentFile: layout.configFile,
        user: layout.serviceUser,
        group: layout.serviceGroup,
        memoryHigh: String(512 * 1024 * 1024),
        memoryMax: String(768 * 1024 * 1024),
        tasksMax: "128",
        limitNOFILE: "8192",
        noNewPrivileges: "yes",
        unitSha256: state.mismatchedUnitBuilds?.has(buildId) ? "0".repeat(64) : sha256(unit),
      };
    },
    async loadedAuxiliaryUnits() {
      assertTimerQuiesced("verify-auxiliary-units");
      const buildId = await activeBuild();
      return auxiliaryUnits.map((candidate, index) => ({
        name: candidate.name,
        loadState: "loaded",
        needDaemonReload: "no",
        dropInPaths: "",
        fragmentPath: candidate.unitPath,
        unitSha256: state.mismatchedAuxiliaryBuilds?.has(buildId) && index === 0 ? "0".repeat(64) : candidate.sha256,
      }));
    },
    async restartService() { assertTimerQuiesced("restart-application"); restartCount += 1; stopped = false; },
    async stopService() { stopped = true; },
    async suspendAuxiliaryTimers(units: typeof auxiliaryUnits) {
      const prior = units.map((candidate) => ({
        name: candidate.name,
        enabled: timerRuntime.get(candidate.name)?.enabled ?? false,
        active: timerRuntime.get(candidate.name)?.active ?? false,
      }));
      for (const candidate of units) timerRuntime.set(candidate.name, { enabled: false, active: false });
      timerQuiesced = true;
      events.push("suspend-timers-and-services");
      return prior;
    },
    async applyAuxiliaryTimerStates(units: typeof auxiliaryUnits, states: Array<{ name: string; enabled: boolean; active: boolean }>) {
      assertTimerQuiesced("apply-timer-state");
      const byName = new Map(states.map((candidate) => [candidate.name, candidate]));
      for (const unit of units) {
        const desired = byName.get(unit.name);
        if (!desired) throw new Error(`fixture timer state missing: ${unit.name}`);
        timerRuntime.set(unit.name, { enabled: desired.enabled, active: desired.active });
      }
      timerQuiesced = false;
      events.push("timer-state-applied");
    },
    async verifyAuxiliaryTimers(units: typeof auxiliaryUnits) {
      const buildId = await activeBuild();
      return units.map((candidate, index) => ({
        name: candidate.name,
        enabled: state.failedTimerBuilds?.has(buildId) && index === 0 ? false : timerRuntime.get(candidate.name)?.enabled ?? false,
        active: timerRuntime.get(candidate.name)?.active ?? false,
        nextElapse: timerRuntime.get(candidate.name)?.active ? "Sun 2026-08-30 01:20:00 UTC" : "",
      }));
    },
    async waitForHealth(expectedBuildId: string) {
      assertTimerQuiesced("wait-for-health");
      return state.failedHealthBuilds?.has(expectedBuildId)
        ? { ok: false, buildId: expectedBuildId }
        : { ok: true, buildId: expectedBuildId, summaryState: "attention" };
    },
    async waitForLegacyHealth() {
      assertTimerQuiesced("wait-for-legacy-health");
      return state.failedLegacyHealth ? { ok: false } : { ok: true, receiverModel: "RSPdx", confirmedSampleRateHz: 10_000_000 };
    },
  };
}

function legacyRollbackDescriptor(candidateBuildId: string, expectedMainUnitSha256: string) {
  return {
    snapshotId: "legacy-snapshot-20260823",
    packageTreeSha256: "4".repeat(64),
    candidateBuildId,
    expectedMainUnitSha256,
    expectedLiveObservation: {
      receiverModel: "RSPdx",
      receiverIdentitySha256: "5".repeat(64),
      confirmedSampleRateHz: 10_000_000,
      simulation: false,
      dataDomain: "field",
    },
  };
}

function legacyRollbackArtifactFileName(record: { legacyMigration?: { rollbackArtifact?: { fileName?: string } } | null }): string {
  const fileName = record.legacyMigration?.rollbackArtifact?.fileName;
  expect(fileName).toMatch(/^legacy-rollback-/);
  if (!fileName) throw new Error("Fixture activation did not publish its legacy rollback artifact");
  return fileName;
}

async function activeBuildId(layout: ReturnType<typeof normalizeDeploymentLayout>): Promise<string | undefined> {
  try {
    const target = path.resolve(path.dirname(layout.activeLink), await readlink(layout.activeLink));
    return JSON.parse(await readFile(path.join(target, "dist/release.json"), "utf8")).buildId;
  } catch {
    return undefined;
  }
}

async function externalHashes(layout: ReturnType<typeof normalizeDeploymentLayout>) {
  return Promise.all([
    readFile(layout.configFile).then(sha256),
    readFile(path.join(layout.storageDirectory, "evidence.keep")).then(sha256),
    readFile(path.join(layout.runtimeConfigDirectory, "operational.json")).then(sha256),
  ]);
}

describe("immutable deployment release manager", () => {
  it("health-gates exact packaged identity without confusing commissioning with service activation", () => {
    const body = {
      schemaVersion: 2,
      ok: false,
      productionReady: false,
      currentHealth: { state: "attention", ready: false },
      identity: { release: {
        buildId: "release-a",
        serverBuildId: "release-a",
        clientBuildId: "release-a",
        integrity: "release-metadata",
      } },
    };
    expect(evaluateDeploymentHealth(body, "release-a")).toMatchObject({
      ok: true,
      buildId: "release-a",
      currentHealthState: "attention",
      productionReady: false,
    });
    expect(evaluateDeploymentHealth({ ...body, currentHealth: { state: "critical" } }, "release-a").ok).toBe(false);
    expect(evaluateDeploymentHealth({
      ...body,
      identity: { release: { ...body.identity.release, clientBuildId: "stale-client" } },
    }, "release-a").ok).toBe(false);
    expect(evaluateDeploymentHealth({ ...body, schemaVersion: 1 }, "release-a").ok).toBe(false);
  });

  it("binds the bounded non-secret operations configuration to the exact activation layout", async () => {
    const { layout } = await deploymentFixture();
    const restorePath = path.join(path.dirname(layout.storageDirectory), "restore-drills");
    const tlsCertificate = path.join(path.dirname(layout.configFile), "tls/rf-monitor.crt");
    const expected = [
      "RFMON_OPS_HEALTH_URL=http://127.0.0.1:8080/api/health",
      `RFMON_OPS_STORAGE_DIR=${layout.storageDirectory}`,
      `RFMON_OPS_EVIDENCE_ROOTS=${layout.storageDirectory}/field/evidence,${layout.storageDirectory}/test/evidence`,
      `RFMON_OPS_RESTORE_STAGING_ROOT=${restorePath}`,
      `RFMON_OPS_TLS_CERTIFICATE=${tlsCertificate}`,
      "RFMON_OPS_DISK_RESERVE_BYTES=5368709120",
    ].join("\n") + "\n";
    const input = { contents: expected, layout, backendPort: 8080, tlsCertificate, restorePath };
    expect(evaluateOperationsConfiguration(input)).toEqual({ offHostBackupConfigured: false });
    expect(evaluateOperationsConfiguration({
      ...input,
      contents: `${expected}RFMON_OPS_BACKUP_ROOT=${path.join(path.dirname(layout.installRoot), "off-host-backup")}\n`,
    })).toEqual({ offHostBackupConfigured: true });
    expect(() => evaluateOperationsConfiguration({
      ...input,
      contents: expected.replace(layout.storageDirectory, `${layout.storageDirectory}-old`),
    })).toThrow(/does not match.*STORAGE_DIR/i);
    expect(() => evaluateOperationsConfiguration({ ...input, contents: `${expected}SECRET_TOKEN=value\n` })).toThrow(/unsupported/i);
  });

  it("stages a fresh read-only release with lockfile-only dependencies and digest-bound SBOM/audit", async () => {
    const { root, layout } = await deploymentFixture();
    const source = await sourceFixture(root, "1.0.0", "fresh");
    const hooks = stageHooks();
    const before = await externalHashes(layout);
    const staged = await stageRelease({ sourceRoot: source, layout, hooks, now: () => "2026-08-23T14:00:00.000Z" });

    expect(staged.state).toBe("staged");
    expect(hooks.installs).toBe(1);
    expect(path.dirname(staged.releaseDirectory)).toBe(layout.releasesDirectory);
    expect((await stat(staged.releaseDirectory)).mode & 0o777).toBe(0o555);
    expect((await stat(path.join(staged.releaseDirectory, "package-lock.json"))).mode & 0o777).toBe(0o444);
    const verified = await verifyInstalledRelease(staged.releaseDirectory);
    expect(verified.manifest).toMatchObject({
      release: { buildId: staged.release.buildId },
      install: {
        lockfileOnly: true,
        dependencyCommand: "/usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --fund=false",
        nodeModulesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      supplyChain: { auditPassed: true },
      runtimeIntegration: {
        entryPointsSha256: expect.any(Object),
        auxiliaryTemplatesSha256: expect.any(Object),
      },
      remotePortReachability: "not-run-external",
    });
    expect(Object.keys(verified.manifest.runtimeIntegration.entryPointsSha256)).toHaveLength(7);
    expect(Object.keys(verified.manifest.runtimeIntegration.auxiliaryTemplatesSha256)).toHaveLength(AUXILIARY_UNIT_SPECS.length);
    expect(verified.manifest.supplyChain.sbomSha256).toBe(sha256(await readFile(path.join(staged.releaseDirectory, "deployment/sbom.spdx.json"))));
    expect(verified.manifest.supplyChain.auditSha256).toBe(sha256(await readFile(path.join(staged.releaseDirectory, "deployment/npm-audit.json"))));
    expect(await externalHashes(layout)).toEqual(before);
    await expect(lstat(layout.activeLink)).rejects.toMatchObject({ code: "ENOENT" });

    const dependencyFile = path.join(staged.releaseDirectory, "node_modules/production-only/package.json");
    await chmod(staged.releaseDirectory, 0o755);
    await chmod(path.join(staged.releaseDirectory, "node_modules"), 0o755);
    await chmod(path.dirname(dependencyFile), 0o755);
    await chmod(dependencyFile, 0o644);
    await writeFile(dependencyFile, "{\"tampered\":true}\n");
    await expect(verifyInstalledRelease(staged.releaseDirectory)).rejects.toThrow(/dependency tree no longer matches/i);
  });

  it("reuses an identical immutable release without reinstalling or changing external data", async () => {
    const { root, layout } = await deploymentFixture();
    const source = await sourceFixture(root, "1.0.0", "reinstall");
    const hooks = stageHooks();
    const first = await stageRelease({ sourceRoot: source, layout, hooks });
    const before = await externalHashes(layout);
    const second = await stageRelease({ sourceRoot: source, layout, hooks });
    expect(second).toMatchObject({ state: "reused", releaseDirectory: first.releaseDirectory, release: first.release });
    expect(hooks.installs).toBe(1);
    expect(await externalHashes(layout)).toEqual(before);
  });

  it("atomically upgrades, verifies the loaded unit and health build identity, then rolls back deterministically", async () => {
    const { root, layout } = await deploymentFixture();
    const sourceA = await sourceFixture(root, "1.0.0", "a");
    const sourceB = await sourceFixture(root, "1.1.0", "b");
    const stagedA = await stageRelease({ sourceRoot: sourceA, layout, hooks: stageHooks() });
    const stagedB = await stageRelease({ sourceRoot: sourceB, layout, hooks: stageHooks() });
    const hooks = activationHooks(layout);
    const before = await externalHashes(layout);

    await activateRelease({ releaseId: stagedA.release.buildId, layout, hooks });
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);
    const upgraded = await activateRelease({ releaseId: stagedB.release.buildId, layout, hooks });
    expect(upgraded).toMatchObject({ state: "complete", release: { buildId: stagedB.release.buildId }, previousRelease: { buildId: stagedA.release.buildId } });
    expect(await activeBuildId(layout)).toBe(stagedB.release.buildId);
    expect((await readdir(layout.installRoot)).filter((name) => name.includes(".next-"))).toEqual([]);
    expect(await readFile(layout.unitPath, "utf8")).toContain(`User=${layout.serviceUser}\nGroup=${layout.serviceGroup}`);
    expect(await readFile(layout.unitPath, "utf8")).not.toContain("@@");
    expect(Object.keys(upgraded.loadedAuxiliaryUnitsSha256)).toHaveLength(AUXILIARY_UNIT_SPECS.length);
    for (const specification of AUXILIARY_UNIT_SPECS) {
      const installed = await readFile(path.join(path.dirname(layout.unitPath), specification.name), "utf8");
      expect(installed).not.toContain("@@");
    }

    const rolledBack = await rollbackRelease({ releaseId: stagedA.release.buildId, layout, hooks });
    expect(rolledBack).toMatchObject({ action: "rollback", state: "complete", release: { buildId: stagedA.release.buildId } });
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);
    expect(await externalHashes(layout)).toEqual(before);
  });

  it("restores the previous release when new health/build identity fails", async () => {
    const { root, layout } = await deploymentFixture();
    const sourceA = await sourceFixture(root, "1.0.0", "health-a");
    const sourceB = await sourceFixture(root, "1.1.0", "health-b");
    const stagedA = await stageRelease({ sourceRoot: sourceA, layout, hooks: stageHooks() });
    const stagedB = await stageRelease({ sourceRoot: sourceB, layout, hooks: stageHooks() });
    const state = { failedHealthBuilds: new Set<string>() };
    const hooks = activationHooks(layout, state);
    await activateRelease({ releaseId: stagedA.release.buildId, layout, hooks });
    state.failedHealthBuilds.add(stagedB.release.buildId);

    await expect(activateRelease({ releaseId: stagedB.release.buildId, layout, hooks })).rejects.toThrow(/previous release restored/i);
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);
    expect(hooks.restartCount).toBe(3);
    const records = await Promise.all((await readdir(layout.recordsDirectory)).filter((name) => name.endsWith(".json")).map((name) => readFile(path.join(layout.recordsDirectory, name), "utf8").then(JSON.parse)));
    expect(records).toContainEqual(expect.objectContaining({ action: "activate", state: "failed", release: expect.objectContaining({ buildId: stagedB.release.buildId }), rollback: expect.objectContaining({ state: "restored" }) }));
  });

  it("quiesces every timer/service through activation and restores the prior enable state on rollback", async () => {
    const { root, layout } = await deploymentFixture();
    const stagedA = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "quiesce-a"), layout, hooks: stageHooks() });
    const stagedB = await stageRelease({ sourceRoot: await sourceFixture(root, "1.1.0", "quiesce-b"), layout, hooks: stageHooks() });
    const state = { failedHealthBuilds: new Set<string>() };
    const hooks = activationHooks(layout, state);
    await activateRelease({ releaseId: stagedA.release.buildId, layout, hooks });
    const firstTimer = AUXILIARY_UNIT_SPECS.find((candidate) => candidate.kind === "timer")!.name;
    hooks.setTimerState(firstTimer, { enabled: false, active: false });
    const priorStates = hooks.timerStates;
    const eventOffset = hooks.events.length;
    state.failedHealthBuilds.add(stagedB.release.buildId);

    await expect(activateRelease({ releaseId: stagedB.release.buildId, layout, hooks })).rejects.toThrow(/previous release restored/i);
    expect(hooks.timerWindowViolations).toBe(0);
    expect(hooks.timerStates).toEqual(priorStates);
    const events = hooks.events.slice(eventOffset);
    const firstSuspend = events.indexOf("suspend-timers-and-services");
    const firstInstall = events.indexOf("install-application-unit");
    const failedHealth = events.indexOf("wait-for-health");
    const rollbackSuspend = events.indexOf("suspend-timers-and-services", firstSuspend + 1);
    const rollbackInstall = events.indexOf("install-application-unit", firstInstall + 1);
    expect(firstSuspend).toBe(0);
    expect(firstInstall).toBeGreaterThan(firstSuspend);
    expect(failedHealth).toBeGreaterThan(firstInstall);
    expect(rollbackSuspend).toBeGreaterThan(failedHealth);
    expect(rollbackInstall).toBeGreaterThan(rollbackSuspend);
  });

  it("leaves no active link or application unit when first activation fails health", async () => {
    const { root, layout } = await deploymentFixture();
    const source = await sourceFixture(root, "1.0.0", "fresh-health-fail");
    const staged = await stageRelease({ sourceRoot: source, layout, hooks: stageHooks() });
    const hooks = activationHooks(layout, { failedHealthBuilds: new Set([staged.release.buildId]) });

    await expect(activateRelease({ releaseId: staged.release.buildId, layout, hooks })).rejects.toThrow(/previous release was absent/i);
    expect(await activeBuildId(layout)).toBeUndefined();
    await expect(lstat(layout.unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(hooks.stopped).toBe(true);
  });

  it("records a sealed legacy migration only after the exact candidate becomes healthy", async () => {
    const { root, layout } = await deploymentFixture();
    const staged = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "legacy-success"), layout, hooks: stageHooks() });
    const legacyUnit = "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n";
    await writeFile(layout.unitPath, legacyUnit);
    const hooks = activationHooks(layout);
    const record = await activateRelease({
      releaseId: staged.release.buildId,
      layout,
      hooks,
      legacyRollback: legacyRollbackDescriptor(staged.release.buildId, sha256(legacyUnit)),
    });
    expect(record).toMatchObject({
      state: "complete",
      previousRelease: null,
      legacyMigration: {
        snapshotId: "legacy-snapshot-20260823",
        packageTreeSha256: "4".repeat(64),
        rollbackVerifiedBeforeActivation: true,
        rollbackArtifact: {
          fileName: expect.stringMatching(/^legacy-rollback-legacy-snapshot-20260823-[a-f0-9]{16}\.json$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      productionQualified: false,
    });
    const rollbackArtifact = JSON.parse(await readFile(path.join(layout.recordsDirectory, legacyRollbackArtifactFileName(record)), "utf8"));
    expect(rollbackArtifact).toMatchObject({
      recordType: "rf-monitor-legacy-rollback-artifact",
      snapshotId: "legacy-snapshot-20260823",
      candidateBuildId: staged.release.buildId,
      unitBundle: { mainUnit: { contents: legacyUnit, sha256: sha256(legacyUnit) } },
      qualificationUse: "migration-rollback-only",
    });
    expect(await activeBuildId(layout)).toBe(staged.release.buildId);
  });

  it("restores the exact legacy unit and prior timer states when first candidate health fails", async () => {
    const { root, layout } = await deploymentFixture();
    const staged = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "legacy-failure"), layout, hooks: stageHooks() });
    const legacyUnit = "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n";
    await writeFile(layout.unitPath, legacyUnit);
    const firstTimer = AUXILIARY_UNIT_SPECS.find((candidate) => candidate.kind === "timer")!;
    const legacyTimerUnit = "[Timer]\nOnUnitActiveSec=60\n";
    await writeFile(path.join(path.dirname(layout.unitPath), firstTimer.name), legacyTimerUnit);
    const hooks = activationHooks(layout, { failedHealthBuilds: new Set([staged.release.buildId]) });
    hooks.setTimerState(firstTimer.name, { enabled: true, active: true });

    await expect(activateRelease({
      releaseId: staged.release.buildId,
      layout,
      hooks,
      legacyRollback: legacyRollbackDescriptor(staged.release.buildId, sha256(legacyUnit)),
    })).rejects.toThrow(/legacy service restored/i);
    expect(await activeBuildId(layout)).toBeUndefined();
    expect(await readFile(layout.unitPath, "utf8")).toBe(legacyUnit);
    expect(await readFile(path.join(path.dirname(layout.unitPath), firstTimer.name), "utf8")).toBe(legacyTimerUnit);
    expect(hooks.timerStates[firstTimer.name]).toEqual({ enabled: true, active: true });
    expect(hooks.stopped).toBe(false);
    expect(hooks.timerWindowViolations).toBe(0);
  });

  it("manually restores the sealed legacy service from the persisted rollback artifact", async () => {
    const { root, layout } = await deploymentFixture();
    const staged = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "legacy-manual"), layout, hooks: stageHooks() });
    const legacyUnit = "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n";
    await writeFile(layout.unitPath, legacyUnit);
    const hooks = activationHooks(layout);
    const descriptor = legacyRollbackDescriptor(staged.release.buildId, sha256(legacyUnit));
    const activated = await activateRelease({ releaseId: staged.release.buildId, layout, hooks, legacyRollback: descriptor });
    const artifact = JSON.parse(await readFile(path.join(layout.recordsDirectory, legacyRollbackArtifactFileName(activated)), "utf8"));

    const restored = await restoreLegacyRelease({
      layout,
      hooks,
      legacyRollback: { ...descriptor, unitBundle: artifact.unitBundle, timerStates: artifact.timerStates },
    });
    expect(restored).toMatchObject({
      action: "restore-legacy",
      state: "complete",
      restoredLegacy: { state: "legacy-restored", snapshotId: descriptor.snapshotId },
      productionQualified: false,
    });
    expect(await activeBuildId(layout)).toBeUndefined();
    expect(await readFile(layout.unitPath, "utf8")).toBe(legacyUnit);
    await expect(lstat(path.join(layout.installRoot, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls forward to the immutable candidate if a manual legacy restore cannot regain live receiver health", async () => {
    const { root, layout } = await deploymentFixture();
    const staged = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "legacy-manual-fail"), layout, hooks: stageHooks() });
    const legacyUnit = "[Service]\nExecStart=/usr/bin/node /opt/rf-monitor/dist/server-node/index.js\n";
    await writeFile(layout.unitPath, legacyUnit);
    const state = { failedLegacyHealth: false };
    const hooks = activationHooks(layout, state);
    const descriptor = legacyRollbackDescriptor(staged.release.buildId, sha256(legacyUnit));
    const activated = await activateRelease({ releaseId: staged.release.buildId, layout, hooks, legacyRollback: descriptor });
    const artifact = JSON.parse(await readFile(path.join(layout.recordsDirectory, legacyRollbackArtifactFileName(activated)), "utf8"));
    state.failedLegacyHealth = true;

    await expect(restoreLegacyRelease({
      layout,
      hooks,
      legacyRollback: { ...descriptor, unitBundle: artifact.unitBundle, timerStates: artifact.timerStates },
    })).rejects.toThrow(/immutable candidate restored/i);
    expect(await activeBuildId(layout)).toBe(staged.release.buildId);
    expect(await readFile(layout.unitPath, "utf8")).toContain(`${layout.activeLink}/dist/server-node/index.js`);
  });

  it("rolls back on loaded-systemd mismatch before accepting health", async () => {
    const { root, layout } = await deploymentFixture();
    const sourceA = await sourceFixture(root, "1.0.0", "unit-a");
    const sourceB = await sourceFixture(root, "1.1.0", "unit-b");
    const stagedA = await stageRelease({ sourceRoot: sourceA, layout, hooks: stageHooks() });
    const stagedB = await stageRelease({ sourceRoot: sourceB, layout, hooks: stageHooks() });
    const state = { mismatchedUnitBuilds: new Set<string>() };
    const hooks = activationHooks(layout, state);
    await activateRelease({ releaseId: stagedA.release.buildId, layout, hooks });
    state.mismatchedUnitBuilds.add(stagedB.release.buildId);
    await expect(activateRelease({ releaseId: stagedB.release.buildId, layout, hooks })).rejects.toThrow(/previous release restored.*loaded systemd unit/i);
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);
  });

  it("rolls back when an auxiliary unit or timer activation does not match the release", async () => {
    const { root, layout } = await deploymentFixture();
    const stagedA = await stageRelease({ sourceRoot: await sourceFixture(root, "1.0.0", "aux-a"), layout, hooks: stageHooks() });
    const stagedB = await stageRelease({ sourceRoot: await sourceFixture(root, "1.1.0", "aux-b"), layout, hooks: stageHooks() });
    const state = { mismatchedAuxiliaryBuilds: new Set<string>(), failedTimerBuilds: new Set<string>() };
    const hooks = activationHooks(layout, state);
    await activateRelease({ releaseId: stagedA.release.buildId, layout, hooks });

    state.mismatchedAuxiliaryBuilds.add(stagedB.release.buildId);
    await expect(activateRelease({ releaseId: stagedB.release.buildId, layout, hooks })).rejects.toThrow(/previous release restored.*auxiliary systemd unit/i);
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);

    state.mismatchedAuxiliaryBuilds.clear();
    state.failedTimerBuilds.add(stagedB.release.buildId);
    await expect(activateRelease({ releaseId: stagedB.release.buildId, layout, hooks })).rejects.toThrow(/previous release restored.*timer activation/i);
    expect(await activeBuildId(layout)).toBe(stagedA.release.buildId);
  });

  it("fails preflight for TLS/firewall/Nginx/clock/disk before switching the active release", async () => {
    const { root, layout } = await deploymentFixture();
    const source = await sourceFixture(root, "1.0.0", "preflight");
    const staged = await stageRelease({ sourceRoot: source, layout, hooks: stageHooks() });
    const bad = structuredClone(GOOD_PREFLIGHT) as typeof GOOD_PREFLIGHT;
    (bad.checks as Record<string, boolean>).tlsCertificate = false;
    (bad.checks as Record<string, boolean>).firewallActive = false;
    (bad.checks as Record<string, boolean>).nginxConfiguration = false;
    (bad.checks as Record<string, boolean>).clockSynchronized = false;
    (bad.checks as Record<string, boolean>).diskReserve = false;
    (bad.checks as Record<string, boolean>).operationsConfig = false;
    (bad.checks as Record<string, boolean>).restoreStaging = false;
    const hooks = activationHooks(layout, { preflight: bad });

    await expect(activateRelease({ releaseId: staged.release.buildId, layout, hooks })).rejects.toThrow(/tlsCertificate.*diskReserve|diskReserve.*tlsCertificate/i);
    expect(await activeBuildId(layout)).toBeUndefined();
    expect(hooks.restartCount).toBe(0);
    expect(() => validateDeploymentPreflight({ ...GOOD_PREFLIGHT, remotePortReachability: "passed" })).toThrow(/external qualification check/i);
  });

  it("rejects lockfile mutation and failed audit without publishing a release", async () => {
    const { root, layout } = await deploymentFixture();
    const sourceLock = await sourceFixture(root, "1.0.0", "lock-fail");
    await expect(stageRelease({ sourceRoot: sourceLock, layout, hooks: stageHooks({ mutateLock: true }) })).rejects.toThrow(/modified package-lock/i);
    expect((await readdir(layout.releasesDirectory)).filter((name) => !name.startsWith(".partial-"))).toEqual([]);

    const sourceAudit = await sourceFixture(root, "1.0.1", "audit-fail");
    await expect(stageRelease({ sourceRoot: sourceAudit, layout, hooks: stageHooks({ auditPassed: false }) })).rejects.toThrow(/audit did not pass/i);
    expect((await readdir(layout.releasesDirectory)).filter((name) => !name.startsWith(".partial-"))).toEqual([]);
    expect((await readdir(layout.releasesDirectory)).filter((name) => name.startsWith(".partial-"))).toEqual([]);
  });

  it("removes a just-published release when the stage transaction fails after atomic rename", async () => {
    const { root, layout } = await deploymentFixture();
    const source = await sourceFixture(root, "1.0.0", "post-publish-fail");
    const release = JSON.parse(await readFile(path.join(source, "dist/release.json"), "utf8"));
    const hooks = stageHooks();
    const install = hooks.installDependencies.bind(hooks);
    hooks.installDependencies = async (...arguments_: Parameters<typeof install>) => {
      await install(...arguments_);
      const replacement = `${layout.configFile}.replacement`;
      await writeFile(replacement, "RF_MONITOR_SIMULATION=changed-by-fixture\n");
      await rename(replacement, layout.configFile);
    };

    await expect(stageRelease({ sourceRoot: source, layout, hooks })).rejects.toThrow(/external configuration or evidence path changed/i);
    await expect(lstat(path.join(layout.releasesDirectory, release.buildId))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(layout.releasesDirectory)).filter((name) => name.startsWith(".partial-"))).toEqual([]);
  });

  it("kills deployment subprocesses at their declared wall-clock bound", async () => {
    const started = Date.now();
    await expect(runCommand("/usr/bin/node", ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 })).rejects.toThrow(/timed out after 50 ms/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps npm-style internal executable links but rejects links outside the immutable release", async () => {
    const { root, layout } = await deploymentFixture();
    const safeSource = await sourceFixture(root, "1.0.0", "safe-dependency-link");
    const safe = await stageRelease({ sourceRoot: safeSource, layout, hooks: stageHooks({ dependencySymlink: "safe" }) });
    const installedLink = path.join(safe.releaseDirectory, "node_modules/.bin/production-tool");
    expect((await lstat(installedLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(installedLink)).toBe("../production-only/tool.js");

    const second = await deploymentFixture();
    const external = path.join(second.root, "outside-tool.js");
    await writeFile(external, "preserve me\n", { mode: 0o600 });
    const source = await sourceFixture(second.root, "1.0.1", "external-dependency-link");
    await expect(stageRelease({
      sourceRoot: source,
      layout: second.layout,
      hooks: stageHooks({ dependencySymlink: "external", externalTarget: external }),
    })).rejects.toThrow(/external or broken symbolic link/i);
    expect(await readFile(external, "utf8")).toBe("preserve me\n");
    expect((await stat(external)).mode & 0o777).toBe(0o600);
  });

  it("refuses layouts that put configuration or evidence inside an immutable release root", async () => {
    const root = await fixtureRoot();
    expect(() => normalizeDeploymentLayout({
      installRoot: path.join(root, "install"),
      unitPath: path.join(root, "unit.service"),
      configFile: path.join(root, "install/config.env"),
      storageDirectory: path.join(root, "storage"),
      runtimeConfigDirectory: path.join(root, "runtime"),
    })).toThrow(/must remain outside immutable releases/i);
    expect(() => normalizeDeploymentLayout({
      installRoot: path.join(root, "unsafe install"),
      unitPath: path.join(root, "unit.service"),
      configFile: path.join(root, "config.env"),
      storageDirectory: path.join(root, "storage"),
      runtimeConfigDirectory: path.join(root, "runtime"),
    })).toThrow(/specific absolute path/i);
  });

  it("stops an unidentifiable legacy installation before sudo validation or filesystem mutation", async () => {
    const root = await fixtureRoot();
    const legacy = path.join(root, "legacy-install");
    await mkdir(path.join(legacy, "dist"), { recursive: true });
    await writeFile(path.join(legacy, "package.json"), "{}\n");
    await writeFile(path.join(legacy, "dist/server.js"), "// deployed but unbound\n");
    const before = await readdir(legacy);
    const result = spawnSync("/usr/bin/bash", [path.join(REPOSITORY_ROOT, "deploy/install-ubuntu.sh")], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, RFMON_INSTALL_ROOT: legacy },
      encoding: "utf8",
      timeout: 2_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no verifiable release identity");
    expect(result.stderr).toContain("No installation changes were made");
    expect(result.stdout).not.toContain("==== Checking Ubuntu ====");
    expect(await readdir(legacy)).toEqual(before);
    await expect(lstat(path.join(legacy, "active"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(legacy, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the actual Ubuntu scripts on the immutable, system-Node, fail-closed path", async () => {
    const scripts = ["install-ubuntu.sh", "configure-ubuntu.sh", "configure-web.sh", "rf-monitorctl.sh"];
    for (const script of scripts) {
      const result = spawnSync("/usr/bin/bash", ["-n", path.join(REPOSITORY_ROOT, "deploy", script)], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
    for (const module of ["release-manager.mjs", "release-cli.mjs"]) {
      const result = spawnSync("/usr/bin/node", ["--check", path.join(REPOSITORY_ROOT, "deploy", module)], { encoding: "utf8" });
      expect(result.status, `${module}: ${result.stderr}`).toBe(0);
    }

    const installer = await readFile(path.join(REPOSITORY_ROOT, "deploy/install-ubuntu.sh"), "utf8");
    const releaseCli = await readFile(path.join(REPOSITORY_ROOT, "deploy/release-cli.mjs"), "utf8");
    const control = await readFile(path.join(REPOSITORY_ROOT, "deploy/rf-monitorctl.sh"), "utf8");
    const configureWeb = await readFile(path.join(REPOSITORY_ROOT, "deploy/configure-web.sh"), "utf8");
    expect(installer.indexOf("release-cli.mjs\" stage")).toBeGreaterThan(0);
    expect(installer.indexOf("activation_arguments=(activate --release")).toBeGreaterThan(installer.indexOf("release-cli.mjs\" stage"));
    expect(installer).toContain('activation_arguments+=(--legacy-snapshot "${LEGACY_SNAPSHOT}")');
    expect(installer).toContain('release-cli.mjs" "${activation_arguments[@]}"');
    expect(installer).toContain('legacy-install-snapshot.mjs" verify-current');
    expect(installer).toContain('RFMON_LEGACY_SNAPSHOT must be a specific absolute path');
    expect(installer).toContain("Existing protected configuration, operational profile, and Settings credential were not rewritten.");
    expect(installer).toContain('run check -- --maxWorkers=1');
    expect(installer).toContain("existing_tls_certificate=");
    expect(installer).toContain("existing_tls_private_key=");
    expect(installer).toContain("printf 'TLS_CERTIFICATE=%q\\n'");
    expect(installer).toContain("printf 'TLS_PRIVATE_KEY=%q\\n'");
    expect(installer).toContain('INSTALL_DIR="${RFMON_INSTALL_DIR:-${INSTALL_ROOT}/active}"');
    expect(installer).toContain('RFMON_SERVICE_USER="${SERVICE_USER}"');
    expect(installer).toContain("RFMON_DEFER_APPLICATION_ACTIVATION=true");
    expect(installer).toContain('stage --source "${INSTALL_ROOT}"');
    expect(installer).toContain("Preserved rollback release:");
    const legacyGate = installer.indexOf("Existing RF Monitor files have no verifiable release identity");
    expect(legacyGate).toBeGreaterThan(0);
    expect(legacyGate).toBeLessThan(installer.indexOf("sudo -v"));
    expect(legacyGate).toBeLessThan(installer.indexOf("apt-get update"));
    const existingReleaseVerification = installer.indexOf('verify --release "${existing_release_id}"');
    expect(existingReleaseVerification).toBeGreaterThan(legacyGate);
    expect(existingReleaseVerification).toBeLessThan(installer.indexOf("apt-get update"));
    expect(installer).not.toContain("install_recovery_units_from_release");
    expect(installer).toContain('OPS_CONFIG_FILE="/etc/rf-monitor/ops.conf"');
    expect(installer).toContain("RFMON_OPS_RESTORE_STAGING_ROOT");
    expect(installer).not.toContain("printf 'RFMON_OPS_BACKUP_ROOT=");
    expect(installer).not.toMatch(/\brsync\s+[^\n]*\$\{INSTALL_DIR\}/);
    expect(releaseCli).toContain('["sbom", "--package-lock-only", "--omit=dev", "--sbom-format=spdx"]');
    expect(control).toContain("deploy-release /ABSOLUTE/SOURCE");
    expect(control).toContain("rollback-release BUILD_ID");
    expect(control).toContain("verify-release BUILD_ID");
    expect(control).toContain("/usr/sbin/runuser -u \"${SERVICE_USER}\"");
    expect(control).not.toMatch(/(^|\s)runuser\s+-u/);
    expect(control).toContain('RFMON_INSTALL_DIR="${INSTALL_DIR}"');
    expect(control).toContain("printf 'INVALID %s\\n'");
    expect(configureWeb).toContain("Application health will be checked during release activation.");

    const cliHelp = spawnSync("/usr/bin/node", [path.join(REPOSITORY_ROOT, "deploy/release-cli.mjs"), "--help"], { encoding: "utf8" });
    expect(cliHelp.status, cliHelp.stderr).toBe(0);
    expect(cliHelp.stdout).toContain("Remote LAN reachability is never inferred");
    expect(cliHelp.stdout).toContain("restore-legacy --legacy-snapshot");

    const realTemplate = await readFile(path.join(REPOSITORY_ROOT, "deploy/rf-monitor.service.template"), "utf8");
    const root = await fixtureRoot();
    const layout = normalizeDeploymentLayout({
      installRoot: path.join(root, "install"),
      unitPath: path.join(root, "rf-monitor.service"),
      configFile: path.join(root, "rf-monitor.env"),
      storageDirectory: path.join(root, "evidence"),
      runtimeConfigDirectory: path.join(root, "runtime"),
      serviceUser: "rfmonitor",
      serviceGroup: "rfmonitor",
    });
    const rendered = renderApplicationUnit(realTemplate, layout);
    expect(rendered).not.toContain("@@");
    expect(rendered).toContain("User=rfmonitor\nGroup=rfmonitor");
    expect(rendered).toContain("MemoryHigh=512M\nMemoryMax=768M");
  });
});
