#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_PACKAGE_ROOTS,
  RELEASE_SOURCE_ROOTS,
  digestReleaseFiles,
  walkReleaseFiles,
} from "./release-digest-policy.mjs";

export { RELEASE_PACKAGE_ROOTS, RELEASE_SOURCE_ROOTS, digestReleaseFiles, walkReleaseFiles };

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export async function generateReleaseMetadata({ repositoryRoot = DEFAULT_ROOT, environment = process.env } = {}) {
  const root = path.resolve(repositoryRoot);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const [sourceDigest, dependencyLockDigest] = await Promise.all([
    digestReleaseFiles(root, RELEASE_SOURCE_ROOTS, "rf-monitor-source-unavailable"),
    digestReleaseFiles(root, ["package-lock.json"], "rf-monitor-lock-unavailable"),
  ]);
  const buildId = environment.RF_MONITOR_BUILD_ID?.trim()
    || `${packageJson.version}+${sourceDigest.slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildId)) throw new Error("RF_MONITOR_BUILD_ID is invalid");
  const clientIndexPath = path.join(root, "dist", "client", "index.html");
  const clientIndex = (await readFile(clientIndexPath, "utf8"))
    .replace(/\s*<meta name="rf-monitor-client-build-id" content="[^"]*"\s*\/?>/g, "")
    .replace("</head>", `  <meta name="rf-monitor-client-build-id" content="${buildId}" />\n</head>`);
  if (!clientIndex.includes(`content="${buildId}"`)) throw new Error("Client build identity could not be embedded");
  await writeFile(clientIndexPath, clientIndex, { mode: 0o644 });
  const packageDigest = await digestReleaseFiles(root, RELEASE_PACKAGE_ROOTS, "rf-monitor-package-unavailable");
  const metadata = {
    schemaVersion: 1,
    product: "rf-monitor",
    releaseVersion: packageJson.version,
    buildId,
    sourceDigest,
    packageDigest,
    dependencyLockDigest,
  };
  await writeFile(path.join(root, "dist", "release.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await generateReleaseMetadata();
}
