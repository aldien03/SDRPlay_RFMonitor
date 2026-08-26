import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PACKAGE_ROOTS, RELEASE_SOURCE_ROOTS } from "../../scripts/release-digest-policy.mjs";
import type { ReleaseIdentity, RuntimeIdentity } from "../shared/types";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const MAX_IDENTITY_FILES = 10_000;
const MAX_IDENTITY_FILE_BYTES = 64 * 1024 * 1024;
const serviceBootId = randomUUID();
const serviceStartedAt = new Date().toISOString();

export interface IdentityConfigurationContext {
  catalogVersion: string;
  configurationHash: string;
  configurationRevision: number;
  detectorRuleSetId: string;
  expectedSampleRateHz: number;
}

export interface ReleaseIdentityOptions {
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  executablePath?: string;
}

interface ReleaseMetadataFile {
  schemaVersion: 1;
  product: "rf-monitor";
  releaseVersion: string;
  buildId: string;
  sourceDigest: string;
  packageDigest: string;
  dependencyLockDigest: string;
}

function digestBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function metadataDigest(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return normalized;
}

function metadataBuildId(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim();
  if (!BUILD_ID_PATTERN.test(normalized)) throw new Error(`${name} contains unsupported characters or is too long`);
  return normalized;
}

async function walkIdentityFiles(root: string, relativeRoots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const pending = [...relativeRoots].reverse();
  while (pending.length) {
    const relative = pending.pop()!;
    const absolute = path.join(root, relative);
    let details;
    try {
      details = await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (details.isFile()) {
      if (details.size > MAX_IDENTITY_FILE_BYTES) throw new Error(`Release identity input is too large: ${relative}`);
      files.push(relative.replaceAll(path.sep, "/"));
      if (files.length > MAX_IDENTITY_FILES) throw new Error("Release identity input exceeds its file-count bound");
      continue;
    }
    if (!details.isDirectory()) continue;
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
      if (entry.isSymbolicLink()) continue;
      pending.push(path.join(relative, entry.name));
    }
  }
  return files.sort();
}

async function digestFiles(root: string, relativeRoots: readonly string[], emptyLabel: string): Promise<string> {
  const files = await walkIdentityFiles(root, relativeRoots);
  if (!files.length) return digestBytes(emptyLabel);
  const digest = createHash("sha256");
  for (const relative of files) {
    const bytes = await readFile(path.join(root, ...relative.split("/")));
    digest.update(relative);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function defaultRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function packageVersion(root: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof value.version === "string" && value.version.trim() ? value.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function releaseMetadata(filePath: string): Promise<ReleaseMetadataFile | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<ReleaseMetadataFile>;
    if (
      value.schemaVersion !== 1
      || value.product !== "rf-monitor"
      || typeof value.releaseVersion !== "string"
      || !metadataBuildId(value.buildId, "release metadata buildId")
      || !metadataDigest(value.sourceDigest, "release metadata sourceDigest")
      || !metadataDigest(value.packageDigest, "release metadata packageDigest")
      || !metadataDigest(value.dependencyLockDigest, "release metadata dependencyLockDigest")
    ) throw new Error("Release metadata is incomplete");
    return value as ReleaseMetadataFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve release identity once at process start. Explicit release metadata is
 * required for production qualification; development runs remain traceable but
 * deliberately fail closed as runtime-derived.
 */
export async function loadReleaseIdentity(options: ReleaseIdentityOptions = {}): Promise<ReleaseIdentity> {
  const environment = options.environment ?? process.env;
  const root = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot());
  const executablePath = path.resolve(options.executablePath ?? fileURLToPath(import.meta.url));
  const [derivedSourceDigest, derivedLockDigest] = await Promise.all([
    digestFiles(root, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestFiles(root, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  const packaged = executablePath.includes(`${path.sep}dist${path.sep}server-node${path.sep}`);
  const derivedPackageDigest = packaged
    ? await digestFiles(root, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable")
    : derivedSourceDigest;
  const explicitSourceDigest = metadataDigest(environment.RF_MONITOR_SOURCE_DIGEST, "RF_MONITOR_SOURCE_DIGEST");
  const explicitPackageDigest = metadataDigest(environment.RF_MONITOR_PACKAGE_DIGEST, "RF_MONITOR_PACKAGE_DIGEST");
  const explicitLockDigest = metadataDigest(environment.RF_MONITOR_DEPENDENCY_LOCK_DIGEST, "RF_MONITOR_DEPENDENCY_LOCK_DIGEST");
  const explicitBuildId = metadataBuildId(environment.RF_MONITOR_BUILD_ID, "RF_MONITOR_BUILD_ID");
  const explicitValues = [explicitSourceDigest, explicitPackageDigest, explicitLockDigest, explicitBuildId];
  if (explicitValues.some(Boolean) && !explicitValues.every(Boolean)) {
    throw new Error("Release identity environment metadata must provide build, source, package, and dependency-lock values together");
  }
  if (explicitValues.every(Boolean) && (
    explicitSourceDigest !== derivedSourceDigest
    || explicitPackageDigest !== derivedPackageDigest
    || explicitLockDigest !== derivedLockDigest
  )) throw new Error("Release identity environment digests do not match the installed package");
  const installedMetadata = packaged
    ? await releaseMetadata(path.resolve(environment.RF_MONITOR_RELEASE_METADATA_FILE ?? path.join(root, "dist", "release.json")))
    : undefined;
  const packageJsonVersion = await packageVersion(root);
  if (environment.RF_MONITOR_RELEASE_VERSION?.trim() && environment.RF_MONITOR_RELEASE_VERSION.trim() !== packageJsonVersion) {
    throw new Error("RF_MONITOR_RELEASE_VERSION does not match package.json");
  }
  const metadataMatches = Boolean(installedMetadata
    && installedMetadata.releaseVersion === packageJsonVersion
    && installedMetadata.sourceDigest === derivedSourceDigest
    && installedMetadata.packageDigest === derivedPackageDigest
    && installedMetadata.dependencyLockDigest === derivedLockDigest);
  const sourceDigest = explicitSourceDigest ?? (metadataMatches ? installedMetadata?.sourceDigest : undefined) ?? derivedSourceDigest;
  const packageDigest = explicitPackageDigest ?? (metadataMatches ? installedMetadata?.packageDigest : undefined) ?? derivedPackageDigest;
  const dependencyLockDigest = explicitLockDigest ?? (metadataMatches ? installedMetadata?.dependencyLockDigest : undefined) ?? derivedLockDigest;
  const releaseVersion = environment.RF_MONITOR_RELEASE_VERSION?.trim() || (metadataMatches ? installedMetadata?.releaseVersion : undefined) || packageJsonVersion;
  const buildId = explicitBuildId ?? (metadataMatches ? installedMetadata?.buildId : undefined) ?? `development-${packageDigest.slice(0, 12)}`;
  const serverBuildId = metadataBuildId(environment.RF_MONITOR_SERVER_BUILD_ID, "RF_MONITOR_SERVER_BUILD_ID") ?? buildId;
  const clientBuildId = metadataBuildId(environment.RF_MONITOR_CLIENT_BUILD_ID, "RF_MONITOR_CLIENT_BUILD_ID") ?? buildId;
  return Object.freeze({
    schemaVersion: 1 as const,
    product: "rf-monitor" as const,
    releaseVersion,
    buildId,
    serverBuildId,
    clientBuildId,
    sourceDigest,
    packageDigest,
    dependencyLockDigest,
    integrity: explicitValues.every(Boolean) || metadataMatches
      ? "release-metadata" as const
      : "runtime-derived" as const,
  });
}

export function createRuntimeIdentity(release: ReleaseIdentity, context: IdentityConfigurationContext): RuntimeIdentity {
  return {
    schemaVersion: 1,
    serviceBootId,
    serviceStartedAt,
    nodeVersion: process.version,
    release,
    protocols: {
      health: 2,
      live: 2,
      evidenceManifest: 2,
      catalogSchema: 3,
      operationalSchema: 3,
    },
    configuration: { ...context },
  };
}

export function withIdentityConfiguration(identity: RuntimeIdentity, context: IdentityConfigurationContext): RuntimeIdentity {
  return { ...identity, configuration: { ...context } };
}
