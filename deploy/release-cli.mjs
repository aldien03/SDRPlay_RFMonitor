#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, lstat, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activateRelease,
  normalizeDeploymentLayout,
  rollbackRelease,
  restoreLegacyRelease,
  sha256,
  stageRelease,
  verifyInstalledRelease,
} from "./release-manager.mjs";
import {
  captureLegacyLiveObservation,
  prepareLegacyMigrationRollback,
  verifyLegacyRestorePreflight,
} from "./legacy-install-snapshot.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MAX_COMMAND_BYTES = 32 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;

function environmentLayout(environment = process.env) {
  const installRoot = environment.RFMON_INSTALL_ROOT || "/opt/rf-monitor";
  return normalizeDeploymentLayout({
    installRoot,
    releasesDirectory: environment.RFMON_RELEASES_DIR,
    activeLink: environment.RFMON_ACTIVE_LINK,
    recordsDirectory: environment.RFMON_DEPLOYMENT_RECORDS_DIR,
    unitPath: environment.RFMON_UNIT_PATH || "/etc/systemd/system/rf-monitor.service",
    configFile: environment.RFMON_CONFIG_FILE || "/etc/rf-monitor.env",
    storageDirectory: environment.RFMON_STORAGE_DIR || "/var/lib/rf-monitor/evidence",
    runtimeConfigDirectory: environment.RFMON_RUNTIME_CONFIG_DIR || "/var/lib/rf-monitor/config",
    nodeBinary: environment.RFMON_NODE_BIN || "/usr/bin/node",
    serviceUser: environment.RFMON_SERVICE_USER || "rfmonitor",
    serviceGroup: environment.RFMON_SERVICE_GROUP || "rfmonitor",
  });
}

export function runCommand(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      reject(new Error("Command timeout is outside the bounded deployment range"));
      return;
    }
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const append = (target, chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (timedOut) reject(new Error(`${executable} timed out after ${timeoutMs} ms`));
      else if (bytes > MAX_COMMAND_BYTES) reject(new Error(`${executable} output exceeded its bound`));
      else if (!options.acceptExitCodes?.includes(code) && code !== 0) {
        reject(new Error(`${executable} ${arguments_.join(" ")} failed (${code ?? signal}): ${result.stderr.toString("utf8").trim()}`));
      } else resolve(result);
    });
  });
}

function parseJsonBuffer(value, label) {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

async function readBoundedJsonFile(filePath, label, maximumBytes = 512 * 1024) {
  const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile() || details.size <= 0 || details.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  return parseJsonBuffer(await readFile(filePath), label);
}

async function prepareManualLegacyRestore(layout, bundle, environment) {
  const activeDirectory = await realpath(layout.activeLink);
  if (path.dirname(activeDirectory) !== layout.releasesDirectory) throw new Error("Active release is outside the immutable release directory");
  const installed = await verifyInstalledRelease(activeDirectory);
  const preflight = await verifyLegacyRestorePreflight({
    bundle,
    candidateRoot: activeDirectory,
    healthUrl: environment.RFMON_LOCAL_HEALTH_URL || "http://127.0.0.1:8080/api/health",
    allowUnavailableCurrentReceiver: true,
  });
  if (preflight.candidateBuildId !== installed.release.buildId) throw new Error("Legacy restore snapshot is bound to a different active candidate");
  const current = await readBoundedJsonFile(path.join(layout.installRoot, "current.json"), "Current deployment record");
  const reference = current?.legacyMigration?.rollbackArtifact;
  if (current?.recordType !== "rf-monitor-deployment" || current?.state !== "complete"
    || current?.release?.buildId !== installed.release.buildId
    || current?.legacyMigration?.snapshotId !== preflight.snapshotId
    || current?.legacyMigration?.packageTreeSha256 !== preflight.packageTreeSha256
    || typeof reference?.fileName !== "string"
    || !/^legacy-rollback-[A-Za-z0-9._+-]+-[a-f0-9]{16}\.json$/u.test(reference.fileName)
    || !/^[a-f0-9]{64}$/u.test(String(reference.sha256 ?? ""))) {
    throw new Error("Current deployment record has no matching sealed legacy rollback artifact");
  }
  const artifactPath = path.join(layout.recordsDirectory, reference.fileName);
  if (path.dirname(artifactPath) !== layout.recordsDirectory) throw new Error("Legacy rollback artifact path is unsafe");
  const artifactBytes = await readFile(artifactPath);
  if (artifactBytes.byteLength <= 0 || artifactBytes.byteLength > 512 * 1024 || sha256(artifactBytes) !== reference.sha256) {
    throw new Error("Legacy rollback artifact hash or size is invalid");
  }
  const artifactDetails = await lstat(artifactPath);
  if (artifactDetails.isSymbolicLink() || !artifactDetails.isFile()) throw new Error("Legacy rollback artifact must be a regular file");
  const artifact = parseJsonBuffer(artifactBytes, "Legacy rollback artifact");
  if (artifact?.recordType !== "rf-monitor-legacy-rollback-artifact"
    || artifact.snapshotId !== preflight.snapshotId
    || artifact.packageTreeSha256 !== preflight.packageTreeSha256
    || artifact.candidateBuildId !== preflight.candidateBuildId
    || artifact.qualificationUse !== "migration-rollback-only") {
    throw new Error("Legacy rollback artifact does not match the snapshot and active candidate");
  }
  return {
    ...preflight,
    unitBundle: artifact.unitBundle,
    timerStates: artifact.timerStates,
    rollbackArtifact: reference,
  };
}

function productionStageHooks() {
  return {
    async installDependencies(directory, specification) {
      if (specification.executable !== "/usr/bin/npm") throw new Error("Production install must use /usr/bin/npm");
      await runCommand(specification.executable, specification.arguments, { cwd: directory, timeoutMs: 30 * 60_000 });
    },
    async generateSupplyChain(directory) {
      // npm 11 validates the on-disk tree before applying --omit and reports
      // deliberately pruned development packages as missing. Generate the
      // production SBOM from the frozen lockfile while still omitting dev
      // dependencies; the installed node_modules tree is hashed separately.
      const sbom = await runCommand("/usr/bin/npm", ["sbom", "--package-lock-only", "--omit=dev", "--sbom-format=spdx"], { cwd: directory, timeoutMs: 10 * 60_000 });
      const audit = await runCommand("/usr/bin/npm", ["audit", "--omit=dev", "--json"], { cwd: directory, acceptExitCodes: [0, 1], timeoutMs: 10 * 60_000 });
      const auditValue = parseJsonBuffer(audit.stdout, "npm audit");
      const vulnerabilities = auditValue?.metadata?.vulnerabilities;
      const total = vulnerabilities && typeof vulnerabilities === "object"
        ? Object.entries(vulnerabilities).filter(([name]) => name !== "total").reduce((sum, [, count]) => sum + Number(count || 0), 0)
        : Number.NaN;
      return { sbom: sbom.stdout, audit: audit.stdout, auditPassed: audit.code === 0 && total === 0 };
    },
  };
}

async function commandBoolean(executable, arguments_) {
  try {
    await runCommand(executable, arguments_);
    return true;
  } catch {
    return false;
  }
}

async function tlsChecks(environment) {
  const certificate = environment.RFMON_TLS_CERTIFICATE;
  const privateKey = environment.RFMON_TLS_PRIVATE_KEY;
  if (!certificate || !privateKey) return { certificate: false, keyMatch: false };
  try {
    const [certificateDetails, keyDetails] = await Promise.all([lstat(certificate), lstat(privateKey)]);
    if (certificateDetails.isSymbolicLink() || !certificateDetails.isFile() || keyDetails.isSymbolicLink() || !keyDetails.isFile()) {
      return { certificate: false, keyMatch: false };
    }
    const certificateValid = await commandBoolean("/usr/bin/openssl", ["x509", "-in", certificate, "-noout", "-checkend", "86400"]);
    const certificateKey = await runCommand("/usr/bin/openssl", ["x509", "-in", certificate, "-pubkey", "-noout"]);
    const privateKeyPublic = await runCommand("/usr/bin/openssl", ["pkey", "-in", privateKey, "-pubout"]);
    return {
      certificate: certificateValid,
      keyMatch: createHash("sha256").update(certificateKey.stdout).digest("hex") === createHash("sha256").update(privateKeyPublic.stdout).digest("hex"),
    };
  } catch {
    return { certificate: false, keyMatch: false };
  }
}

const OPS_CONFIG_KEYS = new Set([
  "RFMON_OPS_HEALTH_URL", "RFMON_OPS_STORAGE_DIR", "RFMON_OPS_EVIDENCE_ROOTS", "RFMON_OPS_BACKUP_ROOT",
  "RFMON_OPS_RESTORE_STAGING_ROOT", "RFMON_OPS_TLS_CERTIFICATE", "RFMON_OPS_DISK_RESERVE_BYTES",
  "RFMON_OPS_DAILY_RECORDS", "RFMON_OPS_WEEKLY_RECORDS", "RFMON_OPS_MONTHLY_RECORDS",
  "RFMON_OPS_BACKUP_MAX_AGE_MS", "RFMON_OPS_WEEKLY_MAX_AGE_MS", "RFMON_OPS_MONTHLY_MAX_AGE_MS",
  "RFMON_OPS_VERIFICATION_TIMEOUT_MS", "RFMON_OPS_WEEKLY_JOB_MAX_MS", "RFMON_OPS_MONTHLY_JOB_MAX_MS",
  "RFMON_OPS_RESTART_ATTENTION_COUNT",
]);

function outside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative.startsWith("..") && !path.isAbsolute(relative);
}

export function evaluateOperationsConfiguration({ contents, layout, backendPort, tlsCertificate, restorePath }) {
  if (typeof contents !== "string" || Buffer.byteLength(contents) > 64 * 1024) throw new Error("Operations configuration exceeds its byte bound");
  const values = new Map();
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\x00\s%]+)$/u.exec(line);
    if (!match || !OPS_CONFIG_KEYS.has(match[1]) || values.has(match[1])) throw new Error("Operations configuration contains an unsupported or duplicate entry");
    values.set(match[1], match[2]);
  }
  const expected = {
    RFMON_OPS_HEALTH_URL: `http://127.0.0.1:${backendPort}/api/health`,
    RFMON_OPS_STORAGE_DIR: layout.storageDirectory,
    RFMON_OPS_EVIDENCE_ROOTS: `${layout.storageDirectory}/field/evidence,${layout.storageDirectory}/test/evidence`,
    RFMON_OPS_RESTORE_STAGING_ROOT: restorePath,
    RFMON_OPS_TLS_CERTIFICATE: tlsCertificate,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (values.get(name) !== value) throw new Error(`Operations configuration does not match the activation layout: ${name}`);
  }
  const reserve = values.get("RFMON_OPS_DISK_RESERVE_BYTES");
  if (!reserve || !/^[1-9][0-9]*$/.test(reserve) || !Number.isSafeInteger(Number(reserve))) throw new Error("Operations disk reserve is missing or invalid");
  const backupPath = values.get("RFMON_OPS_BACKUP_ROOT");
  const offHostBackupConfigured = Boolean(backupPath
    && path.isAbsolute(backupPath)
    && outside(layout.storageDirectory, backupPath)
    && outside(restorePath, backupPath)
    && outside(backupPath, restorePath));
  if (backupPath && !offHostBackupConfigured) throw new Error("Configured backup path overlaps evidence or restore staging");
  return { offHostBackupConfigured };
}

async function operationsChecks(layout, environment, backendPort) {
  const configPath = "/etc/rf-monitor/ops.conf";
  const restorePath = environment.RFMON_OPS_RESTORE_STAGING_ROOT || "/var/lib/rf-monitor/restore-drills";
  try {
    if (!path.isAbsolute(restorePath) || /[\x00\s%]/u.test(restorePath)) return { config: false, restoreStaging: false, offHostBackupConfigured: false };
    const [configDetails, restoreDetails] = await Promise.all([lstat(configPath), lstat(restorePath)]);
    if (!configDetails.isFile() || configDetails.isSymbolicLink() || configDetails.size > 64 * 1024 || (configDetails.mode & 0o007) !== 0) {
      return { config: false, restoreStaging: false, offHostBackupConfigured: false };
    }
    const config = await readFile(configPath, "utf8");
    const outsideEvidence = outside(layout.storageDirectory, restorePath);
    const evaluated = evaluateOperationsConfiguration({
      contents: config,
      layout,
      backendPort,
      tlsCertificate: environment.RFMON_TLS_CERTIFICATE,
      restorePath,
    });
    return {
      config: true,
      restoreStaging: restoreDetails.isDirectory() && !restoreDetails.isSymbolicLink() && outsideEvidence,
      offHostBackupConfigured: evaluated.offHostBackupConfigured,
    };
  } catch {
    return { config: false, restoreStaging: false, offHostBackupConfigured: false };
  }
}

function deniedPort(firewallText, port) {
  return firewallText.split(/\r?\n/).some((line) => new RegExp(`(?:^|\\s)${String(port).replace(/\D/g, "")}(?:/tcp)?\\s+DENY\\b`, "i").test(line));
}

export function evaluateDeploymentHealth(body, expectedBuildId) {
  const release = body?.identity?.release;
  const currentState = body?.currentHealth?.state;
  const acceptedState = ["normal", "attention", "simulation"].includes(currentState);
  const buildMatches = release?.buildId === expectedBuildId
    && release?.serverBuildId === expectedBuildId
    && release?.clientBuildId === expectedBuildId;
  return {
    ok: body?.schemaVersion === 2 && release?.integrity === "release-metadata" && buildMatches && acceptedState,
    buildId: buildMatches ? expectedBuildId : undefined,
    healthSchemaVersion: body?.schemaVersion,
    currentHealthState: currentState ?? "unknown",
    productionReady: body?.productionReady === true,
  };
}

async function installUnitFile(unitPath, contents) {
  const existing = await lstat(unitPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error(`systemd unit path cannot be a symbolic link: ${unitPath}`);
  const temporary = `${unitPath}.partial-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, unitPath);
}

async function loadedUnitCore(unitName, unitPath) {
  const show = async (property) => (await runCommand("/usr/bin/systemctl", ["show", `--property=${property}`, "--value", unitName])).stdout.toString("utf8").trim();
  const [loadState, needDaemonReload, dropInPaths, fragmentPath, unitContents] = await Promise.all([
    show("LoadState"), show("NeedDaemonReload"), show("DropInPaths"), show("FragmentPath"), readFile(unitPath),
  ]);
  return { loadState, needDaemonReload, dropInPaths, fragmentPath, unitSha256: sha256(unitContents) };
}

function productionActivationHooks(environment = process.env) {
  const applyAuxiliaryTimerStates = async (units, states) => {
    const byName = new Map(states.map((state) => [state?.name, state]));
    if (byName.size !== units.length) throw new Error("Auxiliary timer state set is incomplete");
    for (const unit of units) {
      const state = byName.get(unit.name);
      if (!state || typeof state.enabled !== "boolean" || typeof state.active !== "boolean") throw new Error(`Auxiliary timer state is invalid: ${unit.name}`);
      if (state.enabled) await runCommand("/usr/bin/systemctl", ["enable", unit.name]);
      else await runCommand("/usr/bin/systemctl", ["disable", unit.name], { acceptExitCodes: [0, 1] });
      if (state.active) await runCommand("/usr/bin/systemctl", ["start", unit.name]);
      else await runCommand("/usr/bin/systemctl", ["stop", unit.name], { acceptExitCodes: [0, 5] });
    }
  };
  return {
    async preflight({ layout }) {
      const minimumFreeBytes = Number(environment.RFMON_DEPLOY_MIN_FREE_BYTES || 2 * 1024 * 1024 * 1024);
      const disk = await statfs(layout.installRoot);
      const freeBytes = disk.bavail * disk.bsize;
      const clock = await runCommand("/usr/bin/timedatectl", ["show", "--property=NTPSynchronized", "--value"], { acceptExitCodes: [0] }).catch(() => undefined);
      const tls = await tlsChecks(environment);
      const nginxConfiguration = await commandBoolean("/usr/sbin/nginx", ["-t"]);
      const nginxActive = await commandBoolean("/usr/bin/systemctl", ["is-active", "--quiet", "nginx.service"]);
      const firewall = await runCommand("/usr/sbin/ufw", ["status"], { acceptExitCodes: [0] }).catch(() => undefined);
      const firewallText = firewall?.stdout.toString("utf8") ?? "";
      const backendPort = Number(environment.RFMON_BACKEND_PORT || 8080);
      const operations = await operationsChecks(layout, environment, backendPort);
      const sdrPorts = String(environment.RFMON_SDRCONNECT_PORTS || "5454").split(",").map(Number)
        .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);
      const backendPortValid = Number.isInteger(backendPort) && backendPort >= 1 && backendPort <= 65_535;
      return {
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        checks: {
          systemNode: process.execPath === "/usr/bin/node" && layout.nodeBinary === "/usr/bin/node",
          lockfileInstall: await access("/usr/bin/npm", constants.X_OK).then(() => true, () => false),
          diskReserve: Number.isFinite(minimumFreeBytes) && minimumFreeBytes > 0 && freeBytes >= minimumFreeBytes,
          clockSynchronized: clock?.stdout.toString("utf8").trim() === "yes",
          tlsCertificate: tls.certificate,
          tlsKeyMatch: tls.keyMatch,
          nginxConfiguration,
          nginxActive,
          firewallActive: /^Status:\s+active$/im.test(firewallText),
          backendPortDenied: backendPortValid && deniedPort(firewallText, backendPort),
          sdrconnectPortDenied: sdrPorts.length > 0 && sdrPorts.every((port) => deniedPort(firewallText, port)),
          operationsConfig: operations.config,
          restoreStaging: operations.restoreStaging,
        },
        values: { freeBytes, minimumFreeBytes, backendPort, sdrPorts, offHostBackupConfigured: operations.offHostBackupConfigured },
        remotePortReachability: "not-run-external",
      };
    },
    async installUnit(unitPath, contents) {
      await installUnitFile(unitPath, contents);
    },
    async installAuxiliaryUnits(units) {
      for (const unit of units) await installUnitFile(unit.unitPath, unit.contents);
    },
    async captureLegacyUnits({ layout, auxiliaryUnits, expectedMainUnitSha256 }) {
      const readUnit = async (unitPath, required) => {
        const details = await lstat(unitPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
        if (!details) {
          if (required) throw new Error(`Legacy systemd unit is missing: ${unitPath}`);
          return { existed: false };
        }
        if (details.isSymbolicLink() || !details.isFile() || details.size > 1024 * 1024) {
          throw new Error(`Legacy systemd unit is not a bounded regular file: ${unitPath}`);
        }
        const contents = await readFile(unitPath, "utf8");
        return { existed: true, contents, sha256: sha256(contents) };
      };
      const main = await readUnit(layout.unitPath, true);
      if (main.sha256 !== expectedMainUnitSha256) throw new Error("Loaded legacy application unit changed after snapshot verification");
      return {
        mainUnit: { unitPath: layout.unitPath, contents: main.contents, sha256: main.sha256 },
        auxiliaryUnits: await Promise.all(auxiliaryUnits.map(async (unit) => ({
          name: unit.name,
          unitPath: unit.unitPath,
          ...await readUnit(unit.unitPath, false),
        }))),
      };
    },
    async restoreLegacyUnits(bundle) {
      await installUnitFile(bundle.mainUnit.unitPath, bundle.mainUnit.contents);
      for (const unit of bundle.auxiliaryUnits) {
        if (unit.existed) await installUnitFile(unit.unitPath, unit.contents);
        else {
          const existing = await lstat(unit.unitPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
          if (existing?.isSymbolicLink()) throw new Error(`Legacy auxiliary unit path became a symbolic link: ${unit.unitPath}`);
          await rm(unit.unitPath, { force: true });
        }
      }
    },
    async daemonReload() {
      await runCommand("/usr/bin/systemctl", ["daemon-reload"]);
    },
    async removeUnit(unitPath) {
      const existing = await lstat(unitPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
      if (existing?.isSymbolicLink()) throw new Error("systemd unit path cannot be a symbolic link");
      await rm(unitPath, { force: true });
    },
    async removeAuxiliaryUnits(units) {
      const timers = units.filter((unit) => unit.kind === "timer").map((unit) => unit.name);
      if (timers.length) await runCommand("/usr/bin/systemctl", ["disable", "--now", ...timers], { acceptExitCodes: [0, 1, 5] });
      for (const unit of units) {
        const existing = await lstat(unit.unitPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
        if (existing?.isSymbolicLink()) throw new Error(`systemd unit path cannot be a symbolic link: ${unit.unitPath}`);
        await rm(unit.unitPath, { force: true });
      }
    },
    async loadedUnit(unitPath) {
      const show = async (property) => (await runCommand("/usr/bin/systemctl", ["show", `--property=${property}`, "--value", "rf-monitor.service"])).stdout.toString("utf8").trim();
      const [
        loadState, needDaemonReload, dropInPaths, fragmentPath, workingDirectory, execStart, environmentFile,
        user, group, memoryHigh, memoryMax, tasksMax, limitNOFILE, noNewPrivileges, unitContents,
      ] = await Promise.all([
        show("LoadState"), show("NeedDaemonReload"), show("DropInPaths"),
        show("FragmentPath"), show("WorkingDirectory"), show("ExecStart"), show("EnvironmentFiles"),
        show("User"), show("Group"), show("MemoryHigh"), show("MemoryMax"), show("TasksMax"),
        show("LimitNOFILE"), show("NoNewPrivileges"), readFile(unitPath),
      ]);
      return {
        loadState,
        needDaemonReload,
        dropInPaths,
        fragmentPath,
        workingDirectory,
        execStart,
        environmentFile: environmentFile.replace(/^-/, "").split(" ")[0],
        user,
        group,
        memoryHigh,
        memoryMax,
        tasksMax,
        limitNOFILE,
        noNewPrivileges,
        unitSha256: sha256(unitContents),
      };
    },
    async loadedAuxiliaryUnits(units) {
      return Promise.all(units.map(async (unit) => ({
        name: unit.name,
        ...await loadedUnitCore(unit.name, unit.unitPath),
      })));
    },
    async restartService() {
      await runCommand("/usr/bin/systemctl", ["restart", "rf-monitor.service"]);
    },
    async stopService() {
      await runCommand("/usr/bin/systemctl", ["stop", "rf-monitor.service"], { acceptExitCodes: [0, 5] });
    },
    async suspendAuxiliaryTimers(units) {
      const states = await Promise.all(units.map(async (unit) => ({
        name: unit.name,
        enabled: await commandBoolean("/usr/bin/systemctl", ["is-enabled", "--quiet", unit.name]),
        active: await commandBoolean("/usr/bin/systemctl", ["is-active", "--quiet", unit.name]),
      })));
      try {
        for (const state of states) {
          if (state.enabled) await runCommand("/usr/bin/systemctl", ["disable", "--now", state.name]);
          else if (state.active) await runCommand("/usr/bin/systemctl", ["stop", state.name]);
        }
        for (const state of states) {
          await runCommand("/usr/bin/systemctl", ["stop", state.name.replace(/\.timer$/, ".service")], { acceptExitCodes: [0, 5] });
        }
      } catch (error) {
        try {
          await applyAuxiliaryTimerStates(units, states);
        } catch (restoreError) {
          throw new Error(`Timer suspension failed and prior timer state could not be restored: ${error instanceof Error ? error.message : String(error)}; ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        throw error;
      }
      return states;
    },
    applyAuxiliaryTimerStates,
    async verifyAuxiliaryTimers(units) {
      return Promise.all(units.map(async (unit) => {
        const [enabled, active, next] = await Promise.all([
          commandBoolean("/usr/bin/systemctl", ["is-enabled", "--quiet", unit.name]),
          commandBoolean("/usr/bin/systemctl", ["is-active", "--quiet", unit.name]),
          runCommand("/usr/bin/systemctl", ["show", "--property=NextElapseUSecRealtime", "--value", unit.name]).catch(() => undefined),
        ]);
        const nextElapse = next?.stdout.toString("utf8").trim() ?? "";
        return { name: unit.name, enabled, active, nextElapse: nextElapse && nextElapse !== "n/a" ? nextElapse : "" };
      }));
    },
    async waitForHealth(expectedBuildId) {
      const healthUrl = environment.RFMON_LOCAL_HEALTH_URL || "http://127.0.0.1:8080/api/health";
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000), headers: { accept: "application/json" } });
          if (response.ok) {
            const body = await response.json();
            const evaluated = evaluateDeploymentHealth(body, expectedBuildId);
            if (evaluated.ok) return evaluated;
          }
        } catch {
          // Service startup and bounded retries are expected during activation.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return { ok: false, buildId: undefined, currentHealthState: "unavailable", productionReady: false };
    },
    async waitForLegacyHealth(expected) {
      const healthUrl = environment.RFMON_LOCAL_HEALTH_URL || "http://127.0.0.1:8080/api/health";
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const observation = await captureLegacyLiveObservation(healthUrl);
          if (observation.receiverModel === expected.receiverModel
            && observation.receiverIdentitySha256 === expected.receiverIdentitySha256
            && observation.confirmedSampleRateHz === expected.confirmedSampleRateHz
            && observation.simulation === false
            && observation.dataDomain === "field") {
            return { ok: true, receiverModel: observation.receiverModel, confirmedSampleRateHz: observation.confirmedSampleRateHz };
          }
        } catch {
          // The legacy service may still be starting after rollback.
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return { ok: false };
    },
  };
}

function usage() {
  return [
    "Usage: sudo /usr/bin/node deploy/release-cli.mjs <command> [options]",
    "",
    "Commands:",
    "  stage --source /ABSOLUTE/SOURCE",
    "  activate --release BUILD_ID",
    "  activate --release BUILD_ID --legacy-snapshot /ABSOLUTE/SEALED-BUNDLE",
    "  deploy --source /ABSOLUTE/SOURCE",
    "  rollback --release BUILD_ID",
    "  restore-legacy --legacy-snapshot /ABSOLUTE/SEALED-BUNDLE",
    "  verify --release BUILD_ID",
    "",
    "All paths are taken from RFMON_* deployment environment variables.",
    "Remote LAN reachability is never inferred by this command.",
  ].join("\n");
}

function arguments_(input) {
  const values = { command: input[0], source: undefined, releaseId: undefined, legacySnapshot: undefined, help: false };
  if (!values.command || values.command === "--help" || values.command === "-h") return { ...values, help: true };
  for (let index = 1; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === "--source" || argument === "--release" || argument === "--legacy-snapshot") {
      const value = input[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--source") values.source = value;
      else if (argument === "--release") values.releaseId = value;
      else values.legacySnapshot = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") values.help = true;
    else throw new Error(`Unknown deployment argument: ${argument}`);
  }
  return values;
}

export async function runDeploymentCli(input, environment = process.env) {
  const parsed = arguments_(input);
  if (parsed.help) return { help: usage() };
  const layout = environmentLayout(environment);
  const stageHooks = productionStageHooks();
  const activationHooks = productionActivationHooks(environment);
  if (parsed.command === "stage") {
    if (!parsed.source) throw new Error("stage requires --source");
    if (parsed.legacySnapshot) throw new Error("stage does not accept --legacy-snapshot");
    return stageRelease({ sourceRoot: parsed.source, layout, hooks: stageHooks });
  }
  if (parsed.command === "activate") {
    if (!parsed.releaseId) throw new Error("activate requires --release");
    const targetDirectory = path.join(layout.releasesDirectory, parsed.releaseId);
    const legacyRollback = parsed.legacySnapshot
      ? await prepareLegacyMigrationRollback({
        bundle: parsed.legacySnapshot,
        candidateRoot: targetDirectory,
        healthUrl: environment.RFMON_LOCAL_HEALTH_URL || "http://127.0.0.1:8080/api/health",
      })
      : undefined;
    return activateRelease({ releaseId: parsed.releaseId, layout, hooks: activationHooks, legacyRollback });
  }
  if (parsed.command === "deploy") {
    if (parsed.legacySnapshot) throw new Error("deploy does not accept --legacy-snapshot; stage and verify the candidate before legacy activation");
    if (!parsed.source) throw new Error("deploy requires --source");
    const staged = await stageRelease({ sourceRoot: parsed.source, layout, hooks: stageHooks });
    const activated = await activateRelease({ releaseId: staged.release.buildId, layout, hooks: activationHooks });
    return { staged, activated };
  }
  if (parsed.command === "rollback") {
    if (parsed.legacySnapshot) throw new Error("rollback does not accept --legacy-snapshot");
    if (!parsed.releaseId) throw new Error("rollback requires --release");
    return rollbackRelease({ releaseId: parsed.releaseId, layout, hooks: activationHooks });
  }
  if (parsed.command === "restore-legacy") {
    if (!parsed.legacySnapshot || parsed.source || parsed.releaseId) throw new Error("restore-legacy requires only --legacy-snapshot");
    const legacyRollback = await prepareManualLegacyRestore(layout, parsed.legacySnapshot, environment);
    return restoreLegacyRelease({ layout, hooks: activationHooks, legacyRollback });
  }
  if (parsed.command === "verify") {
    if (parsed.legacySnapshot) throw new Error("verify does not accept --legacy-snapshot");
    if (!parsed.releaseId) throw new Error("verify requires --release");
    return verifyInstalledRelease(path.join(layout.releasesDirectory, parsed.releaseId));
  }
  throw new Error(`Unknown deployment command: ${parsed.command}`);
}

async function main() {
  if (process.execPath !== "/usr/bin/node") throw new Error(`Deployment requires /usr/bin/node; received ${process.execPath}`);
  if (["--help", "-h"].includes(process.argv[2]) || !process.argv[2]) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.geteuid?.() !== 0) throw new Error("Deployment activation must run as root");
  const result = await runDeploymentCli(process.argv.slice(2));
  if (result.help) process.stdout.write(`${result.help}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
