#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MAX_FILES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;
const RELEASE_FIELDS = [
  "schemaVersion",
  "product",
  "releaseVersion",
  "buildId",
  "sourceDigest",
  "packageDigest",
  "dependencyLockDigest",
];
const MIGRATION_CONTROL_PATHS = ["active", "releases", "deployment-records", "current.json"];

export const LEGACY_SNAPSHOT_HELP = `Usage:
  npm run deploy:legacy-snapshot -- capture --source PATH --unit PATH --output PATH [options]
  npm run deploy:legacy-snapshot -- verify --bundle PATH
  npm run deploy:legacy-snapshot -- verify-current --bundle PATH --source PATH --unit PATH --config PATH [options]
  npm run deploy:legacy-snapshot -- --help

Capture options:
  --source PATH          Exact legacy application root (for example /opt/rf-monitor)
  --unit PATH            Exact active systemd unit file
  --output PATH          New immutable snapshot bundle; it must not already exist
  --candidate-root PATH  Frozen candidate root (default: current repository)
  --config PATH          Protected environment file; contents are hashed, never copied
  --health-url URL       Local health URL (default: http://127.0.0.1:8080/api/health)

Capture is read-only with respect to the installed service. It never stops, starts,
restarts, tunes, or edits the receiver. A missing protected-config hash leaves the
snapshot valid for package recovery but not ready for migration cutover.

verify-current is also read-only. It requires the current package, unit, protected
configuration, candidate release identity, and live physical receiver to match the
sealed bundle immediately before a one-time migration.
`;

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function safeAbsolute(value, label) {
  assertion(typeof value === "string" && path.isAbsolute(value), `${label} must be an absolute path`);
  const normalized = path.normalize(value);
  assertion(normalized !== path.parse(normalized).root && !/[\0\r\n]/u.test(normalized), `${label} is unsafe`);
  return normalized;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function archivePath(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

function stableEntryLine(entry) {
  if (entry.type === "file") return `${entry.path}\0file\0${entry.restoreMode}\0${entry.bytes}\0${entry.sha256}\0`;
  if (entry.type === "symlink") return `${entry.path}\0symlink\0${entry.restoreMode}\0${entry.target}\0`;
  return `${entry.path}\0directory\0${entry.restoreMode}\0`;
}

export function legacyTreeDigest(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(stableEntryLine(entry));
  return digest.digest("hex");
}

async function boundedFileDescriptor(file, label) {
  const details = await lstat(file);
  assertion(details.isFile() && !details.isSymbolicLink(), `${label} must be a regular file`);
  assertion(details.size > 0 && details.size <= MAX_FILE_BYTES, `${label} exceeds its size bound`);
  return {
    bytes: details.size,
    restoreMode: details.mode & 0o777,
    sha256: await fileSha256(file),
  };
}

export async function collectLegacyTree(rootInput, options = {}) {
  const root = safeAbsolute(rootInput, "Legacy source root");
  const excludedTopLevelNames = new Set(options.excludedTopLevelNames ?? []);
  for (const name of excludedTopLevelNames) {
    assertion(typeof name === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(name) && name !== "." && name !== "..", "Legacy tree exclusion is unsafe");
  }
  const rootDetails = await lstat(root);
  assertion(rootDetails.isDirectory() && !rootDetails.isSymbolicLink(), "Legacy source root must be a regular directory");
  const entries = [];
  const pending = [""];
  let totalBytes = 0;
  while (pending.length) {
    const relative = pending.pop();
    const absolute = relative ? path.join(root, relative) : root;
    const children = await readdir(absolute, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
      if (relative === "" && excludedTopLevelNames.has(child.name)) continue;
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const childArchivePath = archivePath(childRelative);
      const childAbsolute = path.join(root, childRelative);
      const details = await lstat(childAbsolute);
      assertion(entries.length < MAX_FILES, "Legacy source exceeds its file-count bound");
      if (details.isDirectory()) {
        entries.push({ path: childArchivePath, type: "directory", restoreMode: details.mode & 0o777 });
        pending.push(childRelative);
        continue;
      }
      if (details.isFile()) {
        assertion(details.size <= MAX_FILE_BYTES, `Legacy source file exceeds its size bound: ${childArchivePath}`);
        totalBytes += details.size;
        assertion(totalBytes <= MAX_TREE_BYTES, "Legacy source exceeds its total byte bound");
        entries.push({
          path: childArchivePath,
          type: "file",
          restoreMode: details.mode & 0o777,
          bytes: details.size,
          sha256: await fileSha256(childAbsolute),
        });
        continue;
      }
      if (details.isSymbolicLink()) {
        const target = await readlink(childAbsolute);
        assertion(!path.isAbsolute(target), `Legacy source contains an absolute symlink: ${childArchivePath}`);
        const resolved = path.resolve(path.dirname(childAbsolute), target);
        assertion(inside(root, resolved) && resolved !== root, `Legacy source symlink escapes the source root: ${childArchivePath}`);
        entries.push({ path: childArchivePath, type: "symlink", restoreMode: 0o777, target });
        continue;
      }
      throw new Error(`Legacy source contains an unsupported entry: ${childArchivePath}`);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    entries,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    symlinkCount: entries.filter((entry) => entry.type === "symlink").length,
    totalBytes,
    treeSha256: legacyTreeDigest(entries),
  };
}

function frozenMode(entry) {
  if (entry.type === "directory") return 0o555;
  return entry.restoreMode & 0o111 ? 0o555 : 0o444;
}

async function copyTree(sourceRoot, destinationRoot, entries) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o755 });
  for (const entry of entries.filter((value) => value.type === "directory")) {
    await mkdir(path.join(destinationRoot, ...entry.path.split("/")), { recursive: true, mode: 0o755 });
  }
  for (const entry of entries.filter((value) => value.type !== "directory")) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const destination = path.join(destinationRoot, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    if (entry.type === "symlink") await symlink(entry.target, destination);
    else {
      await copyFile(source, destination);
      await chmod(destination, frozenMode(entry));
    }
  }
  const directories = entries.filter((value) => value.type === "directory").sort((left, right) => right.path.length - left.path.length);
  for (const entry of directories) await chmod(path.join(destinationRoot, ...entry.path.split("/")), frozenMode(entry));
  await chmod(destinationRoot, 0o555);
}

function exactRelease(value) {
  assertion(value && typeof value === "object" && !Array.isArray(value), "Candidate release metadata is invalid");
  assertion(Object.keys(value).sort().join("\0") === [...RELEASE_FIELDS].sort().join("\0"), "Candidate release metadata has unexpected fields");
  assertion(value.schemaVersion === 1 && value.product === "rf-monitor", "Candidate release metadata is unsupported");
  for (const field of ["sourceDigest", "packageDigest", "dependencyLockDigest"]) {
    assertion(typeof value[field] === "string" && /^[a-f0-9]{64}$/u.test(value[field]), `Candidate ${field} is invalid`);
  }
  assertion(typeof value.buildId === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value.buildId), "Candidate buildId is invalid");
  assertion(typeof value.releaseVersion === "string" && value.releaseVersion.length > 0, "Candidate releaseVersion is invalid");
  return value;
}

async function boundedJsonFile(file, label) {
  const details = await lstat(file);
  assertion(details.isFile() && !details.isSymbolicLink() && details.size > 0 && details.size <= MAX_JSON_BYTES, `${label} is invalid`);
  return JSON.parse(await readFile(file, "utf8"));
}

async function boundedFetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    assertion(response.ok, `${label} returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertion(bytes.byteLength > 0 && bytes.byteLength <= MAX_HTTP_BYTES, `${label} exceeds its response bound`);
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timeout);
  }
}

function liveLegacyObservation(health, snapshot, healthUrl) {
  const receiver = health?.receiverPath?.receivers?.[0];
  const snapshotReceiver = snapshot?.receivers?.find?.((value) => value.id === receiver?.id) ?? snapshot?.receivers?.[0];
  assertion(health?.schemaVersion === 2 && receiver, "Legacy health does not expose receiver-path diagnostics");
  assertion(health?.schedule?.commissioning?.simulation === false, "Legacy service is in simulation mode");
  assertion(receiver.usb === "present" && receiver.transport === "connected" && receiver.frames === "live", "Legacy physical receiver path is not live");
  assertion(receiver.confirmedSampleRateHz === 10_000_000 && receiver.sampleRateMatches === true, "Legacy receiver is not confirmed at 10 MS/s");
  assertion(typeof snapshotReceiver?.deviceName === "string", "Legacy snapshot does not expose receiver identity");
  const identity = /^(RSPdx(?: R2)?)\s*\(([^)]+)\)$/u.exec(snapshotReceiver.deviceName.trim());
  assertion(identity, "Legacy receiver is not an identifiable RSPdx or RSPdx R2");
  return validateLiveObservation({
    healthUrl,
    capturedAt: new Date().toISOString(),
    serviceState: health.summary?.state ?? "unknown",
    receiverModel: identity[1],
    receiverIdentitySha256: sha256(`${identity[1]}\0${identity[2]}`),
    usb: receiver.usb,
    transport: receiver.transport,
    frames: receiver.frames,
    confirmedSampleRateHz: receiver.confirmedSampleRateHz,
    sampleRateMatches: receiver.sampleRateMatches,
    simulation: false,
    dataDomain: "field",
    qualificationUse: "legacy-unbound-not-eligible",
  });
}

function validateLiveObservation(value) {
  assertion(value && typeof value === "object" && !Array.isArray(value), "Legacy live observation is invalid");
  assertion(["RSPdx", "RSPdx R2"].includes(value.receiverModel), "Legacy live observation receiver model is invalid");
  assertion(typeof value.receiverIdentitySha256 === "string" && /^[a-f0-9]{64}$/u.test(value.receiverIdentitySha256), "Legacy live observation receiver identity is invalid");
  assertion(value.usb === "present" && value.transport === "connected" && value.frames === "live", "Legacy live observation is not a physical live receiver path");
  assertion(value.confirmedSampleRateHz === 10_000_000 && value.sampleRateMatches === true, "Legacy live observation is not confirmed at 10 MS/s");
  assertion(value.simulation === false && value.dataDomain === "field", "Legacy live observation is not field-domain data");
  assertion(value.qualificationUse === "legacy-unbound-not-eligible", "Legacy live observation must remain ineligible for qualification");
  return value;
}

export async function captureLegacyLiveObservation(healthUrl) {
  const parsed = new URL(healthUrl);
  assertion(["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname), "Legacy health URL must remain on loopback");
  const snapshotUrl = new URL("/api/snapshot", parsed).toString();
  const [health, snapshot] = await Promise.all([
    boundedFetchJson(parsed.toString(), "Legacy health"),
    boundedFetchJson(snapshotUrl, "Legacy snapshot"),
  ]);
  return liveLegacyObservation(health, snapshot, parsed.toString());
}

async function optionalProtectedFingerprint(configPath) {
  if (!configPath) return { availability: "not-requested", migrationCutoverReady: false };
  const resolved = safeAbsolute(configPath, "Protected configuration path");
  try {
    const descriptor = await boundedFileDescriptor(resolved, "Protected configuration");
    return { availability: "available", path: resolved, ...descriptor, migrationCutoverReady: true };
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error?.code)) {
      const details = await lstat(resolved);
      return {
        availability: "requires-root-sealing",
        path: resolved,
        bytes: details.size,
        restoreMode: details.mode & 0o777,
        migrationCutoverReady: false,
      };
    }
    throw error;
  }
}

async function readManifest(bundle) {
  const manifest = await boundedJsonFile(path.join(bundle, "manifest.json"), "Legacy snapshot manifest");
  assertion(manifest?.schemaVersion === 1 && manifest.recordType === "rf-monitor-legacy-install-snapshot", "Legacy snapshot manifest is unsupported");
  assertion(Array.isArray(manifest.package?.entries), "Legacy snapshot manifest has no package entries");
  exactRelease(manifest.candidateRelease);
  return manifest;
}

function sameRelease(left, right) {
  return RELEASE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

async function verifyStoredTree(packageRoot, expectedEntries) {
  const actual = await collectLegacyTree(packageRoot);
  const normalizedActual = actual.entries.map((entry) => {
    const expected = expectedEntries.find((candidate) => candidate.path === entry.path);
    return expected ? { ...entry, restoreMode: expected.restoreMode } : entry;
  });
  assertion(JSON.stringify(normalizedActual) === JSON.stringify(expectedEntries), "Legacy snapshot package tree does not match its manifest");
  const packageDetails = await lstat(packageRoot);
  assertion((packageDetails.mode & 0o222) === 0, "Legacy snapshot package root is writable");
  for (const entry of actual.entries) {
    if (entry.type === "symlink") continue;
    const details = await lstat(path.join(packageRoot, ...entry.path.split("/")));
    assertion((details.mode & 0o222) === 0, `Legacy snapshot package entry is writable: ${entry.path}`);
  }
  return actual;
}

async function writeChecksums(bundle, manifestBytes, unitBytes) {
  const lines = [
    `${sha256(manifestBytes)}  manifest.json`,
    `${sha256(unitBytes)}  unit/rf-monitor.service`,
  ];
  await writeFile(path.join(bundle, "SHA256SUMS"), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o444 });
}

export async function verifyLegacyInstallSnapshot(bundleInput) {
  const bundle = safeAbsolute(bundleInput, "Legacy snapshot bundle");
  const details = await lstat(bundle);
  assertion(details.isDirectory() && !details.isSymbolicLink(), "Legacy snapshot bundle must be a regular directory");
  const topLevel = (await readdir(bundle)).sort();
  assertion(JSON.stringify(topLevel) === JSON.stringify(["SHA256SUMS", "manifest.json", "package", "unit"]), "Legacy snapshot bundle contains missing or undeclared entries");
  const manifestBytes = await readFile(path.join(bundle, "manifest.json"));
  assertion(manifestBytes.byteLength > 0 && manifestBytes.byteLength <= MAX_JSON_BYTES, "Legacy snapshot manifest exceeds its bound");
  const manifest = await readManifest(bundle);
  assertion(manifest.package.treeSha256 === legacyTreeDigest(manifest.package.entries), "Legacy snapshot manifest tree digest is invalid");
  await verifyStoredTree(path.join(bundle, "package"), manifest.package.entries);
  const unitPath = path.join(bundle, "unit/rf-monitor.service");
  const unit = await boundedFileDescriptor(unitPath, "Stored service unit");
  assertion(unit.bytes === manifest.serviceUnit.bytes && unit.sha256 === manifest.serviceUnit.sha256, "Stored service unit does not match the manifest");
  const checksums = await readFile(path.join(bundle, "SHA256SUMS"), "utf8");
  const expectedChecksums = `${sha256(manifestBytes)}  manifest.json\n${unit.sha256}  unit/rf-monitor.service\n`;
  assertion(checksums === expectedChecksums, "Legacy snapshot checksum file is invalid");
  return {
    valid: true,
    snapshotId: manifest.snapshotId,
    treeSha256: manifest.package.treeSha256,
    candidateBuildId: manifest.candidateRelease.buildId,
    migrationCutoverReady: manifest.migrationCutoverReady === true,
    liveReceiver: manifest.liveObservation.receiverModel,
  };
}

/**
 * Rechecks every mutable migration input against an already immutable snapshot.
 * This function is intentionally read-only and is designed to run as root just
 * before the legacy service is stopped or any installation path is changed.
 */
export async function verifyCurrentLegacyInstall(options) {
  const bundle = safeAbsolute(options.bundle, "Legacy snapshot bundle");
  await verifyLegacyInstallSnapshot(bundle);
  const manifest = await readManifest(bundle);
  const source = safeAbsolute(options.source ?? manifest.package.sourcePath, "Legacy source root");
  const unitPath = safeAbsolute(options.unit ?? manifest.serviceUnit.sourcePath, "Service unit path");
  const configPath = safeAbsolute(options.config ?? manifest.protectedConfiguration?.path, "Protected configuration path");
  const candidateRoot = safeAbsolute(options.candidateRoot ?? DEFAULT_ROOT, "Candidate root");
  assertion(manifest.migrationCutoverReady === true, "Legacy snapshot is not ready for migration cutover");
  assertion(manifest.package.sourcePath === source, "Current legacy source path does not match the snapshot");
  assertion(manifest.serviceUnit.sourcePath === unitPath, "Current service unit path does not match the snapshot");
  assertion(manifest.protectedConfiguration?.path === configPath, "Current protected configuration path does not match the snapshot");
  assertion(manifest.protectedConfiguration?.availability === "available", "Legacy snapshot has no sealed protected-configuration fingerprint");
  const migrationLayoutExclusions = options.allowMigrationLayout === true
    ? MIGRATION_CONTROL_PATHS
    : [];
  for (const entry of manifest.package.entries) {
    assertion(!migrationLayoutExclusions.includes(entry.path.split("/")[0]), "Sealed legacy package conflicts with an immutable deployment-control path");
  }

  const [sourceBefore, unit, protectedConfig, candidateRelease] = await Promise.all([
    collectLegacyTree(source, { excludedTopLevelNames: migrationLayoutExclusions }),
    boundedFileDescriptor(unitPath, "Current service unit"),
    boundedFileDescriptor(configPath, "Current protected configuration"),
    boundedJsonFile(path.join(candidateRoot, "dist/release.json"), "Candidate release metadata").then(exactRelease),
  ]);
  assertion(sourceBefore.treeSha256 === manifest.package.treeSha256, "Current legacy package does not match the snapshot");
  assertion(JSON.stringify(sourceBefore.entries) === JSON.stringify(manifest.package.entries), "Current legacy package entries do not match the snapshot");
  assertion(unit.bytes === manifest.serviceUnit.bytes && unit.restoreMode === manifest.serviceUnit.restoreMode && unit.sha256 === manifest.serviceUnit.sha256, "Current service unit does not match the snapshot");
  const expectedConfig = manifest.protectedConfiguration;
  assertion(protectedConfig.bytes === expectedConfig.bytes && protectedConfig.restoreMode === expectedConfig.restoreMode && protectedConfig.sha256 === expectedConfig.sha256, "Current protected configuration does not match the snapshot");
  assertion(sameRelease(candidateRelease, manifest.candidateRelease), "Current candidate release identity does not match the snapshot");

  const liveObservation = options.liveObservation
    ? validateLiveObservation(options.liveObservation)
    : await captureLegacyLiveObservation(options.healthUrl ?? manifest.liveObservation.healthUrl);
  assertion(liveObservation.receiverModel === manifest.liveObservation.receiverModel
    && liveObservation.receiverIdentitySha256 === manifest.liveObservation.receiverIdentitySha256,
  "Current live receiver identity does not match the snapshot");
  const sourceAfter = await collectLegacyTree(source, { excludedTopLevelNames: migrationLayoutExclusions });
  assertion(sourceAfter.treeSha256 === sourceBefore.treeSha256 && JSON.stringify(sourceAfter.entries) === JSON.stringify(sourceBefore.entries), "Legacy source changed during current-state verification");

  return {
    valid: true,
    currentMatchesSnapshot: true,
    snapshotId: manifest.snapshotId,
    treeSha256: manifest.package.treeSha256,
    candidateBuildId: manifest.candidateRelease.buildId,
    protectedConfigurationSha256: expectedConfig.sha256,
    liveReceiver: liveObservation.receiverModel,
    receiverIdentitySha256: liveObservation.receiverIdentitySha256,
    qualificationUse: "migration-cutover-preflight-only",
    migrationLayoutExcluded: options.allowMigrationLayout === true,
  };
}

export async function verifyLegacyRestorePreflight(options) {
  const bundle = safeAbsolute(options.bundle, "Legacy snapshot bundle");
  await verifyLegacyInstallSnapshot(bundle);
  const manifest = await readManifest(bundle);
  assertion(manifest.migrationCutoverReady === true, "Legacy snapshot is not ready for restore");
  const source = safeAbsolute(options.source ?? manifest.package.sourcePath, "Legacy source root");
  const configPath = safeAbsolute(options.config ?? manifest.protectedConfiguration?.path, "Protected configuration path");
  const candidateRoot = safeAbsolute(options.candidateRoot, "Active candidate root");
  for (const entry of manifest.package.entries) {
    assertion(!MIGRATION_CONTROL_PATHS.includes(entry.path.split("/")[0]), "Sealed legacy package conflicts with an immutable deployment-control path");
  }
  const [sourceBefore, protectedConfig, candidateRelease] = await Promise.all([
    collectLegacyTree(source, { excludedTopLevelNames: MIGRATION_CONTROL_PATHS }),
    boundedFileDescriptor(configPath, "Current protected configuration"),
    boundedJsonFile(path.join(candidateRoot, "dist/release.json"), "Active candidate release metadata").then(exactRelease),
  ]);
  assertion(sourceBefore.treeSha256 === manifest.package.treeSha256
    && JSON.stringify(sourceBefore.entries) === JSON.stringify(manifest.package.entries),
  "Current legacy package does not match the sealed restore snapshot");
  const expectedConfig = manifest.protectedConfiguration;
  assertion(protectedConfig.bytes === expectedConfig.bytes
    && protectedConfig.restoreMode === expectedConfig.restoreMode
    && protectedConfig.sha256 === expectedConfig.sha256,
  "Current protected configuration does not match the sealed restore snapshot");
  assertion(sameRelease(candidateRelease, manifest.candidateRelease), "Active candidate release identity does not match the legacy snapshot");
  let liveObservation;
  try {
    liveObservation = options.liveObservation
      ? validateLiveObservation(options.liveObservation)
      : await captureLegacyLiveObservation(options.healthUrl ?? manifest.liveObservation.healthUrl);
  } catch (error) {
    if (options.allowUnavailableCurrentReceiver !== true
      || !/^(?:Legacy physical receiver path is not live|Legacy live observation is not a physical live receiver path)$/i
        .test(error instanceof Error ? error.message : String(error))) throw error;
  }
  if (liveObservation) {
    assertion(liveObservation.receiverModel === manifest.liveObservation.receiverModel
      && liveObservation.receiverIdentitySha256 === manifest.liveObservation.receiverIdentitySha256,
    "Current live receiver identity does not match the legacy snapshot");
  }
  const sourceAfter = await collectLegacyTree(source, { excludedTopLevelNames: MIGRATION_CONTROL_PATHS });
  assertion(sourceAfter.treeSha256 === sourceBefore.treeSha256
    && JSON.stringify(sourceAfter.entries) === JSON.stringify(sourceBefore.entries),
  "Legacy source changed during restore preflight");
  return {
    valid: true,
    snapshotId: manifest.snapshotId,
    packageTreeSha256: manifest.package.treeSha256,
    candidateBuildId: manifest.candidateRelease.buildId,
    expectedMainUnitSha256: manifest.serviceUnit.sha256,
    expectedLiveObservation: {
      receiverModel: manifest.liveObservation.receiverModel,
      receiverIdentitySha256: manifest.liveObservation.receiverIdentitySha256,
      confirmedSampleRateHz: 10_000_000,
      simulation: false,
      dataDomain: "field",
    },
    qualificationUse: "manual-legacy-restore-preflight-only",
    currentReceiverVerified: Boolean(liveObservation),
  };
}

export async function prepareLegacyMigrationRollback(options) {
  const verified = await verifyCurrentLegacyInstall({ ...options, allowMigrationLayout: true });
  const bundle = safeAbsolute(options.bundle, "Legacy snapshot bundle");
  const manifest = await readManifest(bundle);
  const unitContents = await readFile(path.join(bundle, "unit/rf-monitor.service"), "utf8");
  assertion(sha256(unitContents) === manifest.serviceUnit.sha256, "Stored legacy unit changed after current-state verification");
  return {
    snapshotId: manifest.snapshotId,
    packageTreeSha256: manifest.package.treeSha256,
    candidateBuildId: manifest.candidateRelease.buildId,
    expectedMainUnitSha256: manifest.serviceUnit.sha256,
    expectedLiveObservation: {
      receiverModel: manifest.liveObservation.receiverModel,
      receiverIdentitySha256: manifest.liveObservation.receiverIdentitySha256,
      confirmedSampleRateHz: 10_000_000,
      simulation: false,
      dataDomain: "field",
    },
    verified,
    qualificationUse: "migration-rollback-only",
  };
}

export async function captureLegacyInstallSnapshot(options) {
  const source = safeAbsolute(options.source, "Legacy source root");
  const unitPath = safeAbsolute(options.unit, "Service unit path");
  const output = safeAbsolute(options.output, "Legacy snapshot output");
  const candidateRoot = safeAbsolute(options.candidateRoot ?? DEFAULT_ROOT, "Candidate root");
  const outputParent = path.dirname(output);
  assertion(!inside(source, output) && !inside(output, source), "Legacy snapshot output must remain outside the source tree");
  await lstat(output).then(() => { throw new Error("Legacy snapshot output already exists"); }, (error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const [sourceBefore, unit, candidateRelease, liveObservation, protectedConfig] = await Promise.all([
    collectLegacyTree(source),
    boundedFileDescriptor(unitPath, "Active service unit"),
    boundedJsonFile(path.join(candidateRoot, "dist/release.json"), "Candidate release metadata").then(exactRelease),
    options.liveObservation ? Promise.resolve(validateLiveObservation(options.liveObservation)) : captureLegacyLiveObservation(options.healthUrl ?? "http://127.0.0.1:8080/api/health"),
    optionalProtectedFingerprint(options.config),
  ]);
  const snapshotId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${sourceBefore.treeSha256.slice(0, 12)}`;
  const temporary = path.join(outputParent, `.partial-${path.basename(output)}-${process.pid}-${randomUUID()}`);
  await mkdir(outputParent, { recursive: true, mode: 0o750 });
  await mkdir(temporary, { mode: 0o750 });
  let published = false;
  try {
    await copyTree(source, path.join(temporary, "package"), sourceBefore.entries);
    await mkdir(path.join(temporary, "unit"), { mode: 0o755 });
    const unitBytes = await readFile(unitPath);
    await writeFile(path.join(temporary, "unit/rf-monitor.service"), unitBytes, { flag: "wx", mode: 0o444 });
    await chmod(path.join(temporary, "unit"), 0o555);
    const sourceAfter = await collectLegacyTree(source);
    assertion(sourceBefore.treeSha256 === sourceAfter.treeSha256, "Legacy source changed while it was being captured");
    await verifyStoredTree(path.join(temporary, "package"), sourceBefore.entries);
    const manifest = {
      schemaVersion: 1,
      recordType: "rf-monitor-legacy-install-snapshot",
      snapshotId,
      createdAt: new Date().toISOString(),
      package: {
        sourcePath: source,
        treeSha256: sourceBefore.treeSha256,
        fileCount: sourceBefore.fileCount,
        symlinkCount: sourceBefore.symlinkCount,
        totalBytes: sourceBefore.totalBytes,
        entries: sourceBefore.entries,
      },
      serviceUnit: { sourcePath: unitPath, ...unit },
      protectedConfiguration: protectedConfig,
      liveObservation,
      candidateRelease,
      rollbackScope: {
        packageAndUnitCaptured: true,
        protectedConfigurationCopied: false,
        fieldEvidenceCopied: false,
        fieldEvidenceMustRemainInPlace: true,
        qualificationUse: "migration-rollback-only",
      },
      migrationCutoverReady: protectedConfig.migrationCutoverReady === true,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    assertion(manifestBytes.byteLength <= MAX_JSON_BYTES, "Legacy snapshot manifest exceeds its bound");
    await writeFile(path.join(temporary, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o444 });
    await writeChecksums(temporary, manifestBytes, unitBytes);
    await chmod(temporary, 0o555);
    await rename(temporary, output);
    published = true;
    return await verifyLegacyInstallSnapshot(output);
  } catch (error) {
    if (!published) {
      await thawAndRemove(temporary).catch(() => undefined);
    }
    throw error;
  }
}

async function thawAndRemove(root) {
  const pending = [root];
  const directories = [];
  while (pending.length) {
    const current = pending.pop();
    const details = await lstat(current).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!details) continue;
    if (details.isDirectory() && !details.isSymbolicLink()) {
      await chmod(current, 0o755).catch(() => undefined);
      directories.push(current);
      for (const child of await readdir(current)) pending.push(path.join(current, child));
    } else if (!details.isSymbolicLink()) await chmod(current, 0o644).catch(() => undefined);
  }
  directories.sort((left, right) => right.length - left.length);
  await rm(root, { recursive: true, force: true });
}

function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { help: true };
  const command = arguments_[0];
  assertion(["capture", "verify", "verify-current"].includes(command), "Expected capture, verify, or verify-current command");
  const values = { command };
  const allowed = new Set(["--source", "--unit", "--output", "--candidate-root", "--config", "--health-url", "--bundle"]);
  for (let index = 1; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    assertion(allowed.has(key) && typeof value === "string" && !value.startsWith("--"), `Invalid or missing value for ${key ?? "argument"}`);
    assertion(values[key] === undefined, `Duplicate option: ${key}`);
    values[key] = value;
  }
  if (command === "verify") {
    assertion(values["--bundle"] && Object.keys(values).length === 2, "verify requires only --bundle PATH");
  } else if (command === "verify-current") {
    assertion(values["--bundle"] && values["--source"] && values["--unit"] && values["--config"], "verify-current requires --bundle, --source, --unit, and --config");
    assertion(!values["--output"], "verify-current does not accept --output");
  } else {
    assertion(values["--source"] && values["--unit"] && values["--output"], "capture requires --source, --unit, and --output");
    assertion(!values["--bundle"], "capture does not accept --bundle");
  }
  return values;
}

export async function runLegacySnapshotCli(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(LEGACY_SNAPSHOT_HELP);
    return;
  }
  const result = parsed.command === "verify"
    ? await verifyLegacyInstallSnapshot(parsed["--bundle"])
    : parsed.command === "verify-current"
      ? await verifyCurrentLegacyInstall({
        bundle: parsed["--bundle"],
        source: parsed["--source"],
        unit: parsed["--unit"],
        config: parsed["--config"],
        candidateRoot: parsed["--candidate-root"],
        healthUrl: parsed["--health-url"],
      })
      : await captureLegacyInstallSnapshot({
      source: parsed["--source"],
      unit: parsed["--unit"],
      output: parsed["--output"],
      candidateRoot: parsed["--candidate-root"],
      config: parsed["--config"],
      healthUrl: parsed["--health-url"],
    });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runLegacySnapshotCli().catch((error) => {
    process.stderr.write(`Legacy snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
