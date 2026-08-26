import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
  walkReleaseFiles,
} from "../scripts/release-digest-policy.mjs";

export const DEPLOYMENT_SCHEMA_VERSION = 1;
export const DEPLOYMENT_RECORD_TYPE = "rf-monitor-deployment";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const MAX_RELEASE_FILES = 10_000;
const MAX_DEPENDENCY_ENTRIES = 100_000;
const MAX_DEPENDENCY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SUPPLY_CHAIN_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;

export const RELEASE_ENTRY_POINTS = Object.freeze([
  "deploy/rf-monitor-backup.sh",
  "deploy/ops-supervisor.mjs",
  "deploy/recover-application.sh",
  "deploy/recover-sdrconnect.sh",
  "deploy/verify-recovery-supervisor.sh",
  "dist/server-node/evidence-backup.js",
  "dist/server-node/evidence-verifier.js",
]);

export const AUXILIARY_UNIT_SPECS = Object.freeze([
  { name: "rf-monitor-sdr-recovery.service", source: "deploy/rf-monitor-sdr-recovery.service.template", kind: "service", family: "recovery" },
  { name: "rf-monitor-sdr-recovery.timer", source: "deploy/rf-monitor-sdr-recovery.timer", kind: "timer", family: "recovery" },
  { name: "rf-monitor-application-recovery.service", source: "deploy/rf-monitor-application-recovery.service.template", kind: "service", family: "recovery" },
  { name: "rf-monitor-application-recovery.timer", source: "deploy/rf-monitor-application-recovery.timer", kind: "timer", family: "recovery" },
  ...["probe", "daily", "weekly", "monthly"].flatMap((mode) => [
    { name: `rf-monitor-ops-${mode}.service`, source: `deploy/rf-monitor-ops-${mode}.service.template`, kind: "service", family: "operations", mode },
    { name: `rf-monitor-ops-${mode}.timer`, source: `deploy/rf-monitor-ops-${mode}.timer`, kind: "timer", family: "operations", mode },
  ]),
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value === path.parse(value).root || /[\x00\s%]/u.test(value)) {
    throw new Error(`${label} must be a specific absolute path`);
  }
  return path.normalize(value);
}

function serviceAccount(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function releaseId(value) {
  if (!RELEASE_ID_PATTERN.test(String(value ?? ""))) throw new Error("Release build ID is unsafe");
  return value;
}

function releaseIdentity(value, label = "Release metadata") {
  if (!value || value.schemaVersion !== 1 || value.product !== "rf-monitor") throw new Error(`${label} is missing or unsupported`);
  if (!RELEASE_ID_PATTERN.test(String(value.buildId ?? ""))) throw new Error(`${label} build ID is invalid`);
  for (const field of ["sourceDigest", "packageDigest", "dependencyLockDigest"]) {
    if (!SHA256_PATTERN.test(String(value[field] ?? ""))) throw new Error(`${label} ${field} is invalid`);
  }
  if (typeof value.releaseVersion !== "string" || !value.releaseVersion) throw new Error(`${label} release version is invalid`);
  return {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: value.releaseVersion,
    buildId: value.buildId,
    sourceDigest: value.sourceDigest,
    packageDigest: value.packageDigest,
    dependencyLockDigest: value.dependencyLockDigest,
  };
}

export function normalizeDeploymentLayout(input) {
  const installRoot = absolutePath(input.installRoot, "Install root");
  const releasesDirectory = absolutePath(input.releasesDirectory ?? path.join(installRoot, "releases"), "Releases directory");
  const activeLink = absolutePath(input.activeLink ?? path.join(installRoot, "active"), "Active release link");
  const recordsDirectory = absolutePath(input.recordsDirectory ?? path.join(installRoot, "deployment-records"), "Deployment records directory");
  const unitPath = absolutePath(input.unitPath, "systemd unit path");
  const configFile = absolutePath(input.configFile, "Configuration file");
  const storageDirectory = absolutePath(input.storageDirectory, "Evidence storage directory");
  const runtimeConfigDirectory = absolutePath(input.runtimeConfigDirectory, "Runtime configuration directory");
  const nodeBinary = absolutePath(input.nodeBinary ?? "/usr/bin/node", "Node executable");
  const serviceUser = serviceAccount(input.serviceUser ?? "rfmonitor", "Service user");
  const serviceGroup = serviceAccount(input.serviceGroup ?? "rfmonitor", "Service group");
  if (!inside(installRoot, releasesDirectory) || !inside(installRoot, activeLink) || !inside(installRoot, recordsDirectory)) {
    throw new Error("Release, active-link, and deployment-record paths must be inside the install root");
  }
  for (const [label, external] of [["Configuration file", configFile], ["Evidence storage", storageDirectory], ["Runtime configuration", runtimeConfigDirectory]]) {
    if (external === installRoot || inside(installRoot, external)) throw new Error(`${label} must remain outside immutable releases`);
  }
  return {
    installRoot,
    releasesDirectory,
    activeLink,
    recordsDirectory,
    unitPath,
    configFile,
    storageDirectory,
    runtimeConfigDirectory,
    nodeBinary,
    serviceUser,
    serviceGroup,
  };
}

async function regularFile(filePath, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (details.size > maximumBytes) throw new Error(`${label} exceeds its byte bound`);
  return details;
}

async function hashRequiredFiles(root, files, label) {
  const result = {};
  for (const relative of files) {
    const absolute = path.join(root, relative);
    await regularFile(absolute, `${label} ${relative}`, MAX_DEPENDENCY_FILE_BYTES);
    result[relative] = sha256(await readFile(absolute));
  }
  return result;
}

function exactHashMap(actual, expected, label) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`${label} hash manifest is missing`);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error(`${label} hash manifest entries do not match the required set`);
  for (const key of expectedKeys) {
    if (!SHA256_PATTERN.test(String(actual[key] ?? "")) || actual[key] !== expected[key]) {
      throw new Error(`${label} changed or is not bound to the deployment manifest: ${key}`);
    }
  }
}

async function externalState(layout) {
  const result = {};
  for (const [name, target, kind] of [
    ["config", layout.configFile, "file"],
    ["storage", layout.storageDirectory, "directory"],
    ["runtimeConfig", layout.runtimeConfigDirectory, "directory"],
  ]) {
    const details = await lstat(target);
    if (details.isSymbolicLink() || (kind === "file" ? !details.isFile() : !details.isDirectory())) {
      throw new Error(`${name} must be an existing non-symlink ${kind}`);
    }
    result[name] = { path: target, device: details.dev, inode: details.ino };
  }
  return result;
}

function sameExternalState(before, after) {
  return ["config", "storage", "runtimeConfig"].every((name) => before[name].path === after[name].path
    && before[name].device === after[name].device && before[name].inode === after[name].inode);
}

async function readJson(filePath, label, maximumBytes = MAX_RECORD_BYTES) {
  await regularFile(filePath, label, maximumBytes);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function validateSourceRelease(sourceRoot) {
  const root = await realpath(absolutePath(sourceRoot, "Source root"));
  const metadata = releaseIdentity(await readJson(path.join(root, "dist/release.json"), "Source release metadata", 64 * 1024));
  const [sourceDigest, packageDigest, lockDigest] = await Promise.all([
    digestReleaseFiles(root, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(root, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(root, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  if (metadata.sourceDigest !== sourceDigest || metadata.packageDigest !== packageDigest || metadata.dependencyLockDigest !== lockDigest) {
    throw new Error("Source release metadata does not match the source/package/lock contents; rebuild first");
  }
  return { root, metadata };
}

async function copyRelease(sourceRoot, destination) {
  // Preserve the exact tested source as well as the runnable package. Tests
  // are part of sourceDigest even though node_modules contains production
  // dependencies only.
  const files = await walkReleaseFiles(sourceRoot, [...new Set([...RELEASE_SOURCE_ROOTS, ...RELEASE_PACKAGE_ROOTS])]);
  files.push("dist/release.json");
  const unique = [...new Set(files)].sort();
  if (!unique.length || unique.length > MAX_RELEASE_FILES) throw new Error("Release copy file count is invalid");
  for (const relative of unique) {
    const source = path.join(sourceRoot, relative);
    const details = await regularFile(source, `Release input ${relative}`);
    const output = path.join(destination, relative);
    await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    await copyFile(source, output);
    await chmod(output, details.mode & 0o111 ? 0o755 : 0o644);
  }
  return unique.length;
}

async function digestInstalledDependencies(releaseRoot) {
  const dependenciesRoot = path.join(releaseRoot, "node_modules");
  const rootDetails = await lstat(dependenciesRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error("Installed node_modules must be a regular directory");
  const digest = createHash("sha256");
  const pending = [""];
  let entries = 0;
  while (pending.length) {
    const relative = pending.pop();
    const absolute = path.join(dependenciesRoot, relative);
    const details = await lstat(absolute);
    entries += 1;
    if (entries > MAX_DEPENDENCY_ENTRIES) throw new Error("Installed dependency tree exceeds its entry bound");
    const portable = relative.split(path.sep).join("/");
    if (details.isSymbolicLink()) {
      const [link, target] = await Promise.all([readlink(absolute), realpath(absolute).catch(() => undefined)]);
      if (!target || !inside(releaseRoot, target)) throw new Error("Installed dependency tree contains an external or broken symbolic link");
      digest.update(`L\0${portable}\0${link}\0`);
    } else if (details.isDirectory()) {
      digest.update(`D\0${portable}\0`);
      const children = await readdir(absolute);
      for (const child of children.sort().reverse()) pending.push(path.join(relative, child));
    } else if (details.isFile()) {
      if (details.size > MAX_DEPENDENCY_FILE_BYTES) throw new Error(`Installed dependency file exceeds its byte bound: ${portable}`);
      digest.update(`F\0${portable}\0`);
      digest.update(await readFile(absolute));
      digest.update("\0");
    } else throw new Error("Installed dependency tree contains a non-regular entry");
  }
  return digest.digest("hex");
}

async function freezeTree(root) {
  const pending = [root];
  const directories = [];
  while (pending.length) {
    const current = pending.pop();
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      const target = await realpath(current).catch(() => undefined);
      if (!target || !inside(root, target)) throw new Error("Immutable release contains an external or broken symbolic link");
    } else if (details.isDirectory()) {
      directories.push(current);
      for (const entry of await readdir(current)) pending.push(path.join(current, entry));
    } else if (details.isFile()) {
      await chmod(current, details.mode & 0o111 ? 0o555 : 0o444);
    } else throw new Error("Immutable release contains a non-regular entry");
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) await chmod(directory, 0o555);
}

async function thawAndRemove(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
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

function boundedArtifact(value, label) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  if (!contents.byteLength || contents.byteLength > MAX_SUPPLY_CHAIN_BYTES) throw new Error(`${label} is empty or exceeds its bound`);
  JSON.parse(contents.toString("utf8"));
  return contents;
}

async function writeJsonAtomic(filePath, value) {
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (contents.byteLength > MAX_RECORD_BYTES) throw new Error("Deployment record exceeds its byte bound");
  const temporary = `${filePath}.partial-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o440 });
  await rename(temporary, filePath);
}

async function writeAttemptRecord(layout, value) {
  await mkdir(layout.recordsDirectory, { recursive: true, mode: 0o750 });
  const name = `${new Date().toISOString().replace(/[-:.]/g, "")}-${value.action}-${value.release.buildId}-${randomUUID()}.json`;
  await writeFile(path.join(layout.recordsDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o440 });
  return name;
}

async function persistLegacyRollbackArtifact(layout, rollback, unitBundle, timerStates, recordedAt) {
  await mkdir(layout.recordsDirectory, { recursive: true, mode: 0o750 });
  const artifact = {
    schemaVersion: 1,
    recordType: "rf-monitor-legacy-rollback-artifact",
    recordedAt,
    snapshotId: rollback.snapshotId,
    packageTreeSha256: rollback.packageTreeSha256,
    candidateBuildId: rollback.candidateBuildId,
    expectedLiveObservation: rollback.expectedLiveObservation,
    unitBundle,
    timerStates,
    qualificationUse: "migration-rollback-only",
  };
  const contents = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (!contents.byteLength || contents.byteLength > MAX_RECORD_BYTES) throw new Error("Legacy rollback artifact exceeds its byte bound");
  const digest = sha256(contents);
  const fileName = `legacy-rollback-${rollback.snapshotId}-${digest.slice(0, 16)}.json`;
  const filePath = path.join(layout.recordsDirectory, fileName);
  const existing = await readFile(filePath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) {
    if (sha256(existing) !== digest || !existing.equals(contents)) throw new Error("Existing legacy rollback artifact does not match the current cutover");
  } else {
    await writeJsonAtomic(filePath, artifact);
  }
  return { fileName, sha256: digest };
}

export async function verifyInstalledRelease(releaseDirectory) {
  const releaseDetails = await lstat(releaseDirectory);
  if (releaseDetails.isSymbolicLink() || !releaseDetails.isDirectory()) throw new Error("Installed release must be a regular non-symlink directory");
  const manifest = await readJson(path.join(releaseDirectory, "deployment/release-manifest.json"), "Installed release manifest");
  if (manifest?.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION || manifest.recordType !== "rf-monitor-installed-release") {
    throw new Error("Installed release manifest is missing or unsupported");
  }
  const release = releaseIdentity(await readJson(path.join(releaseDirectory, "dist/release.json"), "Installed release metadata", 64 * 1024));
  if (JSON.stringify(release) !== JSON.stringify(manifest.release)) throw new Error("Installed release identity does not match its deployment manifest");
  const sbomPath = path.join(releaseDirectory, "deployment/sbom.spdx.json");
  const auditPath = path.join(releaseDirectory, "deployment/npm-audit.json");
  await Promise.all([
    regularFile(sbomPath, "Installed SBOM", MAX_SUPPLY_CHAIN_BYTES),
    regularFile(auditPath, "Installed audit report", MAX_SUPPLY_CHAIN_BYTES),
  ]);
  if (manifest.install?.lockfileOnly !== true
    || manifest.install?.dependencyCommand !== "/usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --fund=false"
    || !SHA256_PATTERN.test(String(manifest.install?.nodeModulesSha256 ?? ""))) {
    throw new Error("Installed release dependency contract is missing or unsupported");
  }
  const auxiliarySources = [...new Set(AUXILIARY_UNIT_SPECS.map((specification) => specification.source))];
  const [sourceDigest, packageDigest, lockDigest, nodeModulesDigest, sbom, audit, entryPoints, auxiliaryTemplates] = await Promise.all([
    digestReleaseFiles(releaseDirectory, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(releaseDirectory, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(releaseDirectory, ["package-lock.json"], "rf-monitor-lock-unavailable"),
    digestInstalledDependencies(releaseDirectory),
    readFile(sbomPath),
    readFile(auditPath),
    hashRequiredFiles(releaseDirectory, RELEASE_ENTRY_POINTS, "Release entry point"),
    hashRequiredFiles(releaseDirectory, auxiliarySources, "Auxiliary systemd template"),
  ]);
  if (sourceDigest !== release.sourceDigest || packageDigest !== release.packageDigest || lockDigest !== release.dependencyLockDigest) {
    throw new Error("Installed immutable release no longer matches its release digests");
  }
  if (nodeModulesDigest !== manifest.install.nodeModulesSha256) throw new Error("Installed dependency tree no longer matches its deployment manifest");
  if (sha256(sbom) !== manifest.supplyChain.sbomSha256 || sha256(audit) !== manifest.supplyChain.auditSha256 || manifest.supplyChain.auditPassed !== true) {
    throw new Error("Installed supply-chain artifacts are missing, changed, or failed");
  }
  exactHashMap(manifest.runtimeIntegration?.entryPointsSha256, entryPoints, "Release entry point");
  exactHashMap(manifest.runtimeIntegration?.auxiliaryTemplatesSha256, auxiliaryTemplates, "Auxiliary systemd template");
  return { release, manifest };
}

export async function stageRelease(options) {
  const layout = normalizeDeploymentLayout(options.layout);
  const { root: sourceRoot, metadata: release } = await validateSourceRelease(options.sourceRoot);
  const id = releaseId(release.buildId);
  const finalDirectory = path.join(layout.releasesDirectory, id);
  const externalBefore = await externalState(layout);
  await mkdir(layout.releasesDirectory, { recursive: true, mode: 0o755 });
  await mkdir(layout.recordsDirectory, { recursive: true, mode: 0o750 });
  try {
    const existing = await lstat(finalDirectory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Existing release path is not a regular directory");
    const verified = await verifyInstalledRelease(finalDirectory);
    if (!sameExternalState(externalBefore, await externalState(layout))) throw new Error("External configuration or evidence path changed during reinstall");
    return { state: "reused", releaseDirectory: finalDirectory, release: verified.release };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = path.join(layout.releasesDirectory, `.partial-${id}-${process.pid}-${randomUUID()}`);
  let published = false;
  await mkdir(temporary, { mode: 0o750 });
  try {
    const copiedFiles = await copyRelease(sourceRoot, temporary);
    const lockBefore = await digestReleaseFiles(temporary, ["package-lock.json"], "rf-monitor-lock-unavailable");
    if (lockBefore !== release.dependencyLockDigest) throw new Error("Staged lockfile differs from the frozen release");
    await options.hooks.installDependencies(temporary, {
      executable: "/usr/bin/npm",
      arguments: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--fund=false"],
    });
    const lockAfter = await digestReleaseFiles(temporary, ["package-lock.json"], "rf-monitor-lock-unavailable");
    if (lockAfter !== lockBefore) throw new Error("Production dependency installation modified package-lock.json");
    const supply = await options.hooks.generateSupplyChain(temporary, release);
    const sbom = boundedArtifact(supply.sbom, "SBOM");
    const audit = boundedArtifact(supply.audit, "Audit report");
    await mkdir(path.join(temporary, "deployment"), { mode: 0o750 });
    await writeFile(path.join(temporary, "deployment/sbom.spdx.json"), sbom, { flag: "wx", mode: 0o440 });
    await writeFile(path.join(temporary, "deployment/npm-audit.json"), audit, { flag: "wx", mode: 0o440 });
    if (supply.auditPassed !== true) throw new Error("Production dependency audit did not pass");
    const auxiliarySources = [...new Set(AUXILIARY_UNIT_SPECS.map((specification) => specification.source))];
    const [nodeModulesSha256, entryPointsSha256, auxiliaryTemplatesSha256] = await Promise.all([
      digestInstalledDependencies(temporary),
      hashRequiredFiles(temporary, RELEASE_ENTRY_POINTS, "Release entry point"),
      hashRequiredFiles(temporary, auxiliarySources, "Auxiliary systemd template"),
    ]);
    const manifest = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      recordType: "rf-monitor-installed-release",
      createdAt: options.now?.() ?? new Date().toISOString(),
      release,
      install: {
        dependencyCommand: "/usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --fund=false",
        lockfileOnly: true,
        nodeModulesSha256,
        copiedFiles,
        externalConfig: layout.configFile,
        externalEvidence: layout.storageDirectory,
        externalRuntimeConfig: layout.runtimeConfigDirectory,
      },
      supplyChain: { sbomSha256: sha256(sbom), auditSha256: sha256(audit), auditPassed: true },
      runtimeIntegration: { entryPointsSha256, auxiliaryTemplatesSha256 },
      remotePortReachability: "not-run-external",
    };
    await writeJsonAtomic(path.join(temporary, "deployment/release-manifest.json"), manifest);
    await verifyInstalledRelease(temporary);
    await freezeTree(temporary);
    await rename(temporary, finalDirectory);
    published = true;
    if (!sameExternalState(externalBefore, await externalState(layout))) throw new Error("External configuration or evidence path changed during staging");
    await writeAttemptRecord(layout, {
      schemaVersion: 1, recordType: DEPLOYMENT_RECORD_TYPE, action: "stage", state: "complete",
      recordedAt: options.now?.() ?? new Date().toISOString(), release, remotePortReachability: "not-run-external",
    });
    return { state: "staged", releaseDirectory: finalDirectory, release };
  } catch (error) {
    await thawAndRemove(published ? finalDirectory : temporary);
    await writeAttemptRecord(layout, {
      schemaVersion: 1, recordType: DEPLOYMENT_RECORD_TYPE, action: "stage", state: "failed",
      recordedAt: options.now?.() ?? new Date().toISOString(), release,
      reason: error instanceof Error ? error.message : String(error), remotePortReachability: "not-run-external",
    }).catch(() => undefined);
    throw error;
  }
}

export function renderApplicationUnit(template, layout) {
  const replacements = {
    "@@SERVICE_USER@@": layout.serviceUser,
    "@@SERVICE_GROUP@@": layout.serviceGroup,
    "@@INSTALL_DIR@@": layout.activeLink,
    "@@CONFIG_FILE@@": layout.configFile,
    "@@STORAGE_DIR@@": layout.storageDirectory,
    "@@RUNTIME_CONFIG_DIR@@": layout.runtimeConfigDirectory,
    "@@NODE_BIN@@": layout.nodeBinary,
  };
  let rendered = template;
  for (const [marker, value] of Object.entries(replacements)) rendered = rendered.replaceAll(marker, value);
  if (/@@[A-Z0-9_]+@@/.test(rendered)) throw new Error("Application unit has unresolved placeholders");
  const requiredLines = [
    `User=${layout.serviceUser}`,
    `Group=${layout.serviceGroup}`,
    `WorkingDirectory=${layout.activeLink}`,
    `EnvironmentFile=${layout.configFile}`,
    `ExecStart=${layout.nodeBinary} --max-old-space-size=384 ${layout.activeLink}/dist/server-node/index.js`,
    "MemoryHigh=512M",
    "MemoryMax=768M",
    "TasksMax=128",
    "LimitNOFILE=8192",
    "NoNewPrivileges=true",
  ];
  const missing = requiredLines.filter((line) => !rendered.split(/\r?\n/).includes(line));
  if (missing.length) throw new Error(`Application unit contract is incomplete: ${missing.join(",")}`);
  return rendered;
}

function renderAuxiliaryUnit(template, specification, layout) {
  const replacements = {
    "@@SERVICE_USER@@": layout.serviceUser,
    "@@SERVICE_GROUP@@": layout.serviceGroup,
    "@@INSTALL_DIR@@": layout.activeLink,
    "@@CONFIG_FILE@@": layout.configFile,
    "@@CONFIG_AUDIT_FILE@@": path.join(layout.runtimeConfigDirectory, "config-audit.jsonl"),
  };
  let rendered = template;
  for (const [marker, value] of Object.entries(replacements)) rendered = rendered.replaceAll(marker, value);
  if (/@@[A-Z0-9_]+@@/.test(rendered)) throw new Error(`${specification.name} has unresolved placeholders`);
  const lines = rendered.split(/\r?\n/);
  const required = specification.kind === "timer"
    ? ["WantedBy=timers.target"]
    : specification.family === "operations"
      ? [
        `User=${layout.serviceUser}`,
        `Group=${layout.serviceGroup}`,
        `WorkingDirectory=${layout.activeLink}`,
        `EnvironmentFile=${layout.configFile}`,
        "EnvironmentFile=-/etc/rf-monitor/ops.conf",
        `ExecStart=/usr/bin/node ${layout.activeLink}/deploy/ops-supervisor.mjs ${specification.mode}`,
        "ProtectSystem=strict",
        "NoNewPrivileges=true",
      ]
      : [
        `EnvironmentFile=${layout.configFile}`,
        `ExecStart=/bin/bash ${layout.activeLink}/deploy/${specification.name.startsWith("rf-monitor-sdr-") ? "recover-sdrconnect.sh" : "recover-application.sh"}`,
        "ProtectSystem=strict",
        "NoNewPrivileges=true",
      ];
  if (specification.name === "rf-monitor-application-recovery.service") {
    required.push(`Environment=RFMON_CONFIG_AUDIT_FILE=${path.join(layout.runtimeConfigDirectory, "config-audit.jsonl")}`);
  }
  if (specification.kind === "timer") {
    required.push(`Unit=${specification.name.replace(/\.timer$/, ".service")}`);
  }
  const missing = required.filter((line) => !lines.includes(line));
  if (missing.length) throw new Error(`${specification.name} contract is incomplete: ${missing.join(",")}`);
  if (specification.name === "rf-monitor-ops-monthly.service"
    && lines.some((line) => line.startsWith("ReadWritePaths=") && line.includes("restore-drills"))) {
    throw new Error("Monthly restore validation must not receive write access to the restore staging path");
  }
  return rendered;
}

export async function renderAuxiliaryUnits(releaseDirectory, layoutInput) {
  const layout = normalizeDeploymentLayout(layoutInput);
  const unitDirectory = path.dirname(layout.unitPath);
  const units = [];
  for (const specification of AUXILIARY_UNIT_SPECS) {
    const source = path.join(releaseDirectory, specification.source);
    await regularFile(source, `Auxiliary systemd template ${specification.source}`, MAX_DEPENDENCY_FILE_BYTES);
    const contents = renderAuxiliaryUnit(await readFile(source, "utf8"), specification, layout);
    units.push({ ...specification, unitPath: path.join(unitDirectory, specification.name), contents, sha256: sha256(contents) });
  }
  return units;
}

export function validateDeploymentPreflight(report) {
  if (!report || report.schemaVersion !== 1) throw new Error("Deployment preflight report is missing or unsupported");
  const required = [
    "systemNode", "lockfileInstall", "diskReserve", "clockSynchronized", "tlsCertificate", "tlsKeyMatch",
    "nginxConfiguration", "nginxActive", "firewallActive", "backendPortDenied", "sdrconnectPortDenied",
    "operationsConfig", "restoreStaging",
  ];
  const failed = required.filter((name) => report.checks?.[name] !== true);
  if (failed.length) throw new Error(`Deployment preflight failed: ${failed.join(",")}`);
  if (report.remotePortReachability !== "not-run-external") throw new Error("Remote reachability must remain an external qualification check");
  return report;
}

async function currentRelease(layout) {
  let details;
  try {
    details = await lstat(layout.activeLink);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isSymbolicLink()) throw new Error("Active release path is not a symbolic link");
  const target = path.resolve(path.dirname(layout.activeLink), await readlink(layout.activeLink));
  if (!inside(layout.releasesDirectory, target) || path.dirname(target) !== layout.releasesDirectory) throw new Error("Active link does not name one immutable release");
  const verified = await verifyInstalledRelease(target);
  return { directory: target, release: verified.release };
}

async function switchActive(layout, releaseDirectory) {
  const target = path.relative(path.dirname(layout.activeLink), releaseDirectory);
  const temporary = `${layout.activeLink}.next-${process.pid}-${randomUUID()}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, layout.activeLink);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function verifyLoadedUnit(loaded, layout, expectedUnit) {
  const failures = [];
  if (loaded?.loadState !== "loaded") failures.push("load-state");
  if (loaded?.needDaemonReload !== "no") failures.push("daemon-reload-pending");
  if (String(loaded?.dropInPaths ?? "").trim() !== "") failures.push("unapproved-drop-in");
  if (path.normalize(loaded?.fragmentPath ?? "") !== layout.unitPath) failures.push("fragment-path");
  if (path.normalize(loaded?.workingDirectory ?? "") !== layout.activeLink) failures.push("working-directory");
  if (!String(loaded?.execStart ?? "").includes(`${layout.activeLink}/dist/server-node/index.js`)
    || !String(loaded?.execStart ?? "").includes(layout.nodeBinary)) failures.push("exec-start");
  if (path.normalize(loaded?.environmentFile ?? "") !== layout.configFile) failures.push("environment-file");
  if (loaded?.user !== layout.serviceUser) failures.push("service-user");
  if (loaded?.group !== layout.serviceGroup) failures.push("service-group");
  if (String(loaded?.memoryHigh) !== String(512 * 1024 * 1024)) failures.push("memory-high");
  if (String(loaded?.memoryMax) !== String(768 * 1024 * 1024)) failures.push("memory-max");
  if (String(loaded?.tasksMax) !== "128") failures.push("tasks-max");
  if (String(loaded?.limitNOFILE) !== "8192") failures.push("file-limit");
  if (String(loaded?.noNewPrivileges).toLowerCase() !== "yes") failures.push("no-new-privileges");
  if (loaded?.unitSha256 !== sha256(expectedUnit)) failures.push("loaded-unit-hash");
  if (failures.length) throw new Error(`Loaded systemd unit verification failed: ${failures.join(",")}`);
}

function verifyLoadedAuxiliaryUnits(loadedUnits, expectedUnits) {
  if (!Array.isArray(loadedUnits) || loadedUnits.length !== expectedUnits.length) {
    throw new Error("Loaded auxiliary systemd unit set is incomplete");
  }
  const loadedByName = new Map(loadedUnits.map((unit) => [unit?.name, unit]));
  if (loadedByName.size !== expectedUnits.length) throw new Error("Loaded auxiliary systemd unit set contains duplicate or unexpected names");
  for (const expected of expectedUnits) {
    const loaded = loadedByName.get(expected.name);
    const failures = [];
    if (!loaded) failures.push("missing");
    if (loaded?.loadState !== "loaded") failures.push("load-state");
    if (loaded?.needDaemonReload !== "no") failures.push("daemon-reload-pending");
    if (String(loaded?.dropInPaths ?? "").trim() !== "") failures.push("unapproved-drop-in");
    if (path.normalize(loaded?.fragmentPath ?? "") !== expected.unitPath) failures.push("fragment-path");
    if (loaded?.unitSha256 !== expected.sha256) failures.push("loaded-unit-hash");
    if (failures.length) throw new Error(`Loaded auxiliary systemd unit verification failed for ${expected.name}: ${failures.join(",")}`);
  }
}

async function prepareReleaseUnits(releaseDirectory, layout) {
  const template = await readFile(path.join(releaseDirectory, "deploy/rf-monitor.service.template"), "utf8");
  return {
    unit: renderApplicationUnit(template, layout),
    auxiliaryUnits: await renderAuxiliaryUnits(releaseDirectory, layout),
  };
}

function enabledTimerState(units) {
  return units.map((unit) => ({ name: unit.name, enabled: true, active: true }));
}

async function applyRelease({ layout, releaseDirectory, release, hooks, prepared, timerStates }) {
  const { unit, auxiliaryUnits } = prepared ?? await prepareReleaseUnits(releaseDirectory, layout);
  await switchActive(layout, releaseDirectory);
  await hooks.installUnit(layout.unitPath, unit);
  await hooks.installAuxiliaryUnits(auxiliaryUnits);
  await hooks.daemonReload();
  const loaded = await hooks.loadedUnit(layout.unitPath, unit);
  verifyLoadedUnit(loaded, layout, unit);
  verifyLoadedAuxiliaryUnits(await hooks.loadedAuxiliaryUnits(auxiliaryUnits), auxiliaryUnits);
  await hooks.restartService();
  const health = await hooks.waitForHealth(release.buildId);
  if (!health?.ok || health.buildId !== release.buildId) throw new Error("Activated release failed health/build-identity verification");
  const timerUnits = auxiliaryUnits.filter((candidate) => candidate.kind === "timer");
  const desiredTimerStates = timerStates ?? enabledTimerState(timerUnits);
  await hooks.applyAuxiliaryTimerStates(timerUnits, desiredTimerStates);
  const timerRuntime = await hooks.verifyAuxiliaryTimers(timerUnits);
  const runtimeByName = new Map(Array.isArray(timerRuntime) ? timerRuntime.map((timer) => [timer?.name, timer]) : []);
  const timerFailures = timerUnits.filter((timer) => {
    const runtime = runtimeByName.get(timer.name);
    const desired = desiredTimerStates.find((state) => state.name === timer.name);
    return !desired
      || runtime?.enabled !== desired.enabled
      || runtime?.active !== desired.active
      || (desired.active && (typeof runtime?.nextElapse !== "string" || !runtime.nextElapse.trim()));
  });
  if (runtimeByName.size !== timerUnits.length || timerFailures.length) {
    throw new Error(`Auxiliary timer activation verification failed: ${timerFailures.map((timer) => timer.name).join(",") || "unit-set"}`);
  }
  return { unit, auxiliaryUnits, health };
}

async function restorePrevious({ layout, previous, hooks, timerStates, prepared }) {
  if (!previous) {
    await rm(layout.activeLink, { force: true });
    await hooks.stopService();
    await hooks.removeUnit?.(layout.unitPath);
    await hooks.removeAuxiliaryUnits?.(AUXILIARY_UNIT_SPECS.map((specification) => ({
      ...specification,
      unitPath: path.join(path.dirname(layout.unitPath), specification.name),
    })));
    await hooks.daemonReload();
    return { state: "no-previous-release" };
  }
  const applied = await applyRelease({
    layout,
    releaseDirectory: previous.directory,
    release: previous.release,
    hooks,
    prepared,
    timerStates,
  });
  return { state: "restored", release: previous.release, health: applied.health };
}

function validateLegacyRollbackDescriptor(value, targetBuildId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Legacy rollback descriptor is invalid");
  if (typeof value.snapshotId !== "string" || !RELEASE_ID_PATTERN.test(value.snapshotId)) throw new Error("Legacy rollback snapshot ID is invalid");
  if (!SHA256_PATTERN.test(String(value.packageTreeSha256 ?? "")) || !SHA256_PATTERN.test(String(value.expectedMainUnitSha256 ?? ""))) {
    throw new Error("Legacy rollback hashes are invalid");
  }
  if (value.candidateBuildId !== targetBuildId) throw new Error("Legacy rollback snapshot is bound to a different candidate");
  const observation = value.expectedLiveObservation;
  if (!observation || !["RSPdx", "RSPdx R2"].includes(observation.receiverModel)
    || !SHA256_PATTERN.test(String(observation.receiverIdentitySha256 ?? ""))
    || observation.confirmedSampleRateHz !== 10_000_000
    || observation.simulation !== false
    || observation.dataDomain !== "field") {
    throw new Error("Legacy rollback live-receiver identity is invalid");
  }
  return value;
}

function validateCapturedLegacyUnits(bundle, layout, expectedAuxiliaryUnits, expectedMainUnitSha256) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("Captured legacy unit bundle is invalid");
  if (bundle.mainUnit?.unitPath !== layout.unitPath || typeof bundle.mainUnit?.contents !== "string"
    || sha256(bundle.mainUnit.contents) !== expectedMainUnitSha256
    || bundle.mainUnit.sha256 !== expectedMainUnitSha256) {
    throw new Error("Captured legacy application unit does not match the sealed snapshot");
  }
  if (!Array.isArray(bundle.auxiliaryUnits) || bundle.auxiliaryUnits.length !== expectedAuxiliaryUnits.length) {
    throw new Error("Captured legacy auxiliary unit set is incomplete");
  }
  const actual = new Map(bundle.auxiliaryUnits.map((unit) => [unit?.name, unit]));
  if (actual.size !== expectedAuxiliaryUnits.length) throw new Error("Captured legacy auxiliary unit set contains duplicate entries");
  for (const expected of expectedAuxiliaryUnits) {
    const unit = actual.get(expected.name);
    if (!unit || unit.unitPath !== expected.unitPath || typeof unit.existed !== "boolean") {
      throw new Error(`Captured legacy auxiliary unit is invalid: ${expected.name}`);
    }
    if (unit.existed && (typeof unit.contents !== "string" || unit.sha256 !== sha256(unit.contents))) {
      throw new Error(`Captured legacy auxiliary unit hash is invalid: ${expected.name}`);
    }
    if (!unit.existed && (unit.contents !== undefined || unit.sha256 !== undefined)) {
      throw new Error(`Absent legacy auxiliary unit contains data: ${expected.name}`);
    }
  }
  return bundle;
}

async function restoreLegacy({ layout, rollback, unitBundle, hooks, timerUnits, timerStates }) {
  await rm(layout.activeLink, { force: true });
  await hooks.restoreLegacyUnits(unitBundle);
  await hooks.daemonReload();
  await hooks.restartService();
  const health = await hooks.waitForLegacyHealth(rollback.expectedLiveObservation);
  if (!health?.ok) throw new Error("Restored legacy service failed live receiver verification");
  await hooks.applyAuxiliaryTimerStates(timerUnits, timerStates);
  return {
    state: "legacy-restored",
    snapshotId: rollback.snapshotId,
    packageTreeSha256: rollback.packageTreeSha256,
    health,
  };
}

export async function activateRelease(options) {
  const layout = normalizeDeploymentLayout(options.layout);
  const targetDirectory = path.join(layout.releasesDirectory, releaseId(options.releaseId));
  const target = await verifyInstalledRelease(targetDirectory);
  const externalBefore = await externalState(layout);
  const previous = await currentRelease(layout);
  const targetPrepared = await prepareReleaseUnits(targetDirectory, layout);
  const legacyRollback = options.legacyRollback
    ? validateLegacyRollbackDescriptor(options.legacyRollback, target.release.buildId)
    : undefined;
  if (legacyRollback && previous) throw new Error("Legacy rollback cannot be combined with an existing immutable release");
  let previousPrepared;
  if (previous) {
    // Prove the complete rollback unit bundle is renderable before changing
    // either the active link or the loaded systemd configuration.
    previousPrepared = await prepareReleaseUnits(previous.directory, layout);
  }
  const preflight = validateDeploymentPreflight(await options.hooks.preflight({ layout, release: target.release }));
  const timerUnits = targetPrepared.auxiliaryUnits.filter((candidate) => candidate.kind === "timer");
  const legacyUnitBundle = legacyRollback
    ? validateCapturedLegacyUnits(
      await options.hooks.captureLegacyUnits({
        layout,
        auxiliaryUnits: targetPrepared.auxiliaryUnits,
        expectedMainUnitSha256: legacyRollback.expectedMainUnitSha256,
      }),
      layout,
      targetPrepared.auxiliaryUnits,
      legacyRollback.expectedMainUnitSha256,
    )
    : undefined;
  const previousTimerStates = await options.hooks.suspendAuxiliaryTimers(timerUnits);
  let legacyRollbackArtifact;
  try {
    if (legacyRollback) {
      legacyRollbackArtifact = await persistLegacyRollbackArtifact(
        layout,
        legacyRollback,
        legacyUnitBundle,
        previousTimerStates,
        options.now?.() ?? new Date().toISOString(),
      );
    }
    const applied = await applyRelease({
      layout,
      releaseDirectory: targetDirectory,
      release: target.release,
      hooks: options.hooks,
      prepared: targetPrepared,
    });
    if (!sameExternalState(externalBefore, await externalState(layout))) throw new Error("External configuration or evidence path changed during activation");
    const record = {
      schemaVersion: 1, recordType: DEPLOYMENT_RECORD_TYPE, action: options.action ?? "activate", state: "complete",
      recordedAt: options.now?.() ?? new Date().toISOString(), release: target.release,
      previousRelease: previous?.release ?? null, preflightSha256: sha256(JSON.stringify(preflight)),
      loadedUnitSha256: sha256(applied.unit),
      loadedAuxiliaryUnitsSha256: Object.fromEntries(applied.auxiliaryUnits.map((unit) => [unit.name, unit.sha256])),
      previousAuxiliaryTimerStates: previousTimerStates,
      legacyMigration: legacyRollback ? {
        snapshotId: legacyRollback.snapshotId,
        packageTreeSha256: legacyRollback.packageTreeSha256,
        rollbackVerifiedBeforeActivation: true,
        rollbackArtifact: legacyRollbackArtifact,
      } : null,
      health: applied.health,
      offHostBackup: preflight.values?.offHostBackupConfigured === true ? "configured-not-verified" : "attention-unqualified",
      productionQualified: false,
      remotePortReachability: "not-run-external",
    };
    await writeAttemptRecord(layout, record);
    await writeJsonAtomic(path.join(layout.installRoot, "current.json"), record);
    return record;
  } catch (error) {
    let rollback;
    try {
      // Quiesce target-generation timers again before changing the active link
      // back. This also covers failures after timer activation or deployment
      // record persistence, when timers may already be waiting again.
      await options.hooks.suspendAuxiliaryTimers(timerUnits);
      rollback = legacyRollback
        ? await restoreLegacy({
          layout,
          rollback: legacyRollback,
          unitBundle: legacyUnitBundle,
          hooks: options.hooks,
          timerUnits,
          timerStates: previousTimerStates,
        })
        : await restorePrevious({
          layout,
          previous,
          hooks: options.hooks,
          timerStates: previousTimerStates,
          prepared: previousPrepared,
        });
    } catch (rollbackError) {
      rollback = { state: "failed", reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) };
    }
    await writeAttemptRecord(layout, {
      schemaVersion: 1, recordType: DEPLOYMENT_RECORD_TYPE, action: options.action ?? "activate", state: "failed",
      recordedAt: options.now?.() ?? new Date().toISOString(), release: target.release, previousRelease: previous?.release ?? null,
      reason: error instanceof Error ? error.message : String(error), rollback,
      legacyRollbackArtifact: legacyRollbackArtifact ?? null,
      previousAuxiliaryTimerStates: previousTimerStates,
      remotePortReachability: "not-run-external",
    });
    if (rollback.state === "failed") throw new Error(`Activation failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${rollback.reason}`);
    if (rollback.state === "legacy-restored") throw new Error(`Activation failed; legacy service restored: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Activation failed; previous release ${rollback.state === "restored" ? "restored" : "was absent"}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function rollbackRelease(options) {
  const layout = normalizeDeploymentLayout(options.layout);
  const current = await currentRelease(layout);
  if (!current) throw new Error("Cannot roll back without an active release");
  if (current.release.buildId === options.releaseId) throw new Error("Rollback target is already active");
  return activateRelease({ ...options, layout, action: "rollback" });
}

function validateLegacyTimerStates(timerUnits, states) {
  if (!Array.isArray(states) || states.length !== timerUnits.length) throw new Error("Legacy rollback timer state set is incomplete");
  const byName = new Map(states.map((state) => [state?.name, state]));
  if (byName.size !== timerUnits.length) throw new Error("Legacy rollback timer state set contains duplicates");
  for (const unit of timerUnits) {
    const state = byName.get(unit.name);
    if (!state || typeof state.enabled !== "boolean" || typeof state.active !== "boolean") {
      throw new Error(`Legacy rollback timer state is invalid: ${unit.name}`);
    }
  }
  return states;
}

/** Restores a sealed pre-immutable service after a successful first cutover. */
export async function restoreLegacyRelease(options) {
  const layout = normalizeDeploymentLayout(options.layout);
  const current = await currentRelease(layout);
  if (!current) throw new Error("Manual legacy restore requires an active immutable release");
  const rollback = validateLegacyRollbackDescriptor(options.legacyRollback, current.release.buildId);
  const prepared = await prepareReleaseUnits(current.directory, layout);
  const timerUnits = prepared.auxiliaryUnits.filter((candidate) => candidate.kind === "timer");
  const unitBundle = validateCapturedLegacyUnits(
    rollback.unitBundle,
    layout,
    prepared.auxiliaryUnits,
    rollback.expectedMainUnitSha256,
  );
  const legacyTimerStates = validateLegacyTimerStates(timerUnits, rollback.timerStates);
  const externalBefore = await externalState(layout);
  const currentTimerStates = await options.hooks.suspendAuxiliaryTimers(timerUnits);
  try {
    const restored = await restoreLegacy({
      layout,
      rollback,
      unitBundle,
      hooks: options.hooks,
      timerUnits,
      timerStates: legacyTimerStates,
    });
    if (!sameExternalState(externalBefore, await externalState(layout))) throw new Error("External configuration or evidence path changed during legacy restore");
    await rm(path.join(layout.installRoot, "current.json"), { force: true });
    const record = {
      schemaVersion: 1,
      recordType: DEPLOYMENT_RECORD_TYPE,
      action: "restore-legacy",
      state: "complete",
      recordedAt: options.now?.() ?? new Date().toISOString(),
      release: current.release,
      restoredLegacy: restored,
      previousAuxiliaryTimerStates: currentTimerStates,
      productionQualified: false,
      remotePortReachability: "not-run-external",
    };
    await writeAttemptRecord(layout, record);
    return record;
  } catch (error) {
    let candidateRestoration;
    try {
      await options.hooks.suspendAuxiliaryTimers(timerUnits);
      const applied = await applyRelease({
        layout,
        releaseDirectory: current.directory,
        release: current.release,
        hooks: options.hooks,
        prepared,
        timerStates: currentTimerStates,
      });
      candidateRestoration = { state: "restored", release: current.release, health: applied.health };
    } catch (restoreError) {
      candidateRestoration = { state: "failed", reason: restoreError instanceof Error ? restoreError.message : String(restoreError) };
    }
    await writeAttemptRecord(layout, {
      schemaVersion: 1,
      recordType: DEPLOYMENT_RECORD_TYPE,
      action: "restore-legacy",
      state: "failed",
      recordedAt: options.now?.() ?? new Date().toISOString(),
      release: current.release,
      reason: error instanceof Error ? error.message : String(error),
      candidateRestoration,
      productionQualified: false,
      remotePortReachability: "not-run-external",
    }).catch(() => undefined);
    if (candidateRestoration.state === "failed") {
      throw new Error(`Legacy restore failed and candidate restoration failed: ${error instanceof Error ? error.message : String(error)}; ${candidateRestoration.reason}`);
    }
    throw new Error(`Legacy restore failed; immutable candidate restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
