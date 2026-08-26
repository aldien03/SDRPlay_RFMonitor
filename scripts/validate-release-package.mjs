#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
} from "./generate-release-metadata.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export async function validateReleasePackage({ repositoryRoot = DEFAULT_ROOT } = {}) {
  const root = path.resolve(repositoryRoot);
  const [releaseValue, packageValue, clientIndex] = await Promise.all([
    readFile(path.join(root, "dist", "release.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "dist", "client", "index.html"), "utf8"),
  ]);
  const release = object(releaseValue);
  const packageJson = object(packageValue);
  if (release?.schemaVersion !== 1 || release.product !== "rf-monitor") throw new Error("Release metadata is missing or unsupported");
  if (typeof packageJson?.version !== "string" || release.releaseVersion !== packageJson.version) throw new Error("Release version does not match package.json");
  if (typeof release.buildId !== "string" || !BUILD_ID_PATTERN.test(release.buildId)) throw new Error("Release build ID is invalid");
  for (const name of ["sourceDigest", "packageDigest", "dependencyLockDigest"]) {
    if (typeof release[name] !== "string" || !DIGEST_PATTERN.test(release[name])) throw new Error(`Release ${name} is invalid`);
  }
  const embeddedIds = [...clientIndex.matchAll(/<meta\s+name=["']rf-monitor-client-build-id["']\s+content=["']([^"']+)["']\s*\/?>/g)]
    .map((match) => match[1]);
  if (embeddedIds.length !== 1) throw new Error(`Client package must contain exactly one embedded build ID; found ${embeddedIds.length}`);
  if (embeddedIds[0] !== release.buildId) throw new Error("Embedded client build ID does not match release metadata");

  const [sourceDigest, packageDigest, dependencyLockDigest] = await Promise.all([
    digestReleaseFiles(root, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(root, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable"),
    digestReleaseFiles(root, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  if (release.sourceDigest !== sourceDigest) throw new Error("Release source digest does not match the package contents");
  if (release.packageDigest !== packageDigest) throw new Error("Release package digest does not match the package contents");
  if (release.dependencyLockDigest !== dependencyLockDigest) throw new Error("Release dependency-lock digest does not match the package contents");
  return {
    valid: true,
    buildId: release.buildId,
    releaseVersion: release.releaseVersion,
    sourceDigest,
    packageDigest,
    dependencyLockDigest,
    clientBuildId: embeddedIds[0],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const result = await validateReleasePackage();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
