#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleasePackage } from "./validate-release-package.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, "artifacts", "validation", "v1");
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 60_000;

export const V1_HELP = `Usage: npm run validate:v1 -- [--help]\n\nRuns the bounded V1 software qualification and publishes one immutable bundle.\n\nOptions:\n  -h, --help  Show this help without running qualification.\n`;

export function parseV1Arguments(arguments_) {
  let help = false;
  for (const argument of arguments_) {
    if (argument === "--help" || argument === "-h") {
      if (help) throw new Error(`Duplicate argument: ${argument}`);
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help };
}

export const V1_COMMANDS = Object.freeze([
  { id: "typecheck", command: "/usr/bin/npm", args: ["exec", "--", "tsc", "--noEmit"] },
  { id: "unit", command: "/usr/bin/npm", args: ["exec", "--", "vitest", "run", "--reporter=json"] },
  { id: "build", command: "/usr/bin/npm", args: ["run", "build"] },
  { id: "traceability", command: "/usr/bin/npm", args: ["run", "validate:v0"] },
  { id: "release", command: "/usr/bin/npm", args: ["run", "validate:release"] },
  { id: "sites", command: "/usr/bin/npm", args: ["run", "test:sites"] },
  { id: "config", command: "/usr/bin/npm", args: ["run", "validate:config"] },
  { id: "audit", command: "/usr/bin/npm", args: ["audit", "--omit=dev", "--json"] },
  { id: "sbom", command: "/usr/bin/npm", args: ["sbom", "--omit=dev", "--sbom-format=spdx"] },
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value, label) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
  if (buffer.byteLength > MAX_COMMAND_OUTPUT_BYTES) throw new Error(`${label} exceeds the ${MAX_COMMAND_OUTPUT_BYTES}-byte validation bound`);
  return buffer;
}

function exactNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function parseVitestSummary(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Vitest JSON summary is missing");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.testResults)) throw new Error("Vitest JSON summary is missing per-file results");
  const fileStatuses = parsed.testResults.map((result, index) => {
    if (!result || typeof result !== "object" || typeof result.status !== "string") {
      throw new Error(`Vitest file result ${index + 1} has no status`);
    }
    if (!["passed", "failed", "pending", "skipped", "todo", "disabled"].includes(result.status)) {
      throw new Error(`Vitest file result ${index + 1} has unsupported status ${result.status}`);
    }
    return result.status;
  });
  return {
    testFiles: fileStatuses.length,
    passedTestFiles: fileStatuses.filter((status) => status === "passed").length,
    failedTestFiles: fileStatuses.filter((status) => status === "failed").length,
    skippedTestFiles: fileStatuses.filter((status) => !["passed", "failed"].includes(status)).length,
    suites: exactNonNegativeInteger(parsed.numTotalTestSuites, "numTotalTestSuites"),
    passedSuites: exactNonNegativeInteger(parsed.numPassedTestSuites, "numPassedTestSuites"),
    failedSuites: exactNonNegativeInteger(parsed.numFailedTestSuites, "numFailedTestSuites"),
    skippedSuites: exactNonNegativeInteger(parsed.numPendingTestSuites, "numPendingTestSuites"),
    tests: exactNonNegativeInteger(parsed.numTotalTests, "numTotalTests"),
    passedTests: exactNonNegativeInteger(parsed.numPassedTests, "numPassedTests"),
    failedTests: exactNonNegativeInteger(parsed.numFailedTests, "numFailedTests"),
    skippedTests: exactNonNegativeInteger(parsed.numPendingTests, "numPendingTests"),
  };
}

function validateRelease(release) {
  if (release?.schemaVersion !== 1 || release.product !== "rf-monitor") throw new Error("dist/release.json is missing or unsupported");
  for (const field of ["sourceDigest", "packageDigest", "dependencyLockDigest"]) {
    if (!/^[a-f0-9]{64}$/.test(String(release[field] ?? ""))) throw new Error(`Release ${field} is invalid`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(String(release.buildId ?? ""))) throw new Error("Release buildId is invalid");
  return release;
}

/**
 * Recomputes the source, package, dependency-lock, and embedded-client
 * identities after every V1 command. This is deliberately the last candidate
 * read before the immutable record is constructed and published.
 */
export async function validateV1PublicationCandidate({
  repositoryRoot = REPOSITORY_ROOT,
  validatePackage = validateReleasePackage,
} = {}) {
  const validated = await validatePackage({ repositoryRoot });
  if (validated?.valid !== true) throw new Error("Final V1 release-package validation did not pass");
  const release = validateRelease(JSON.parse(await readFile(path.join(repositoryRoot, "dist", "release.json"), "utf8")));
  for (const field of ["releaseVersion", "buildId", "sourceDigest", "packageDigest", "dependencyLockDigest"]) {
    if (release[field] !== validated[field]) throw new Error(`Final V1 release identity changed while validating ${field}`);
  }
  return release;
}

function publicCommandResult(result) {
  const stdout = boundedText(result.stdout, `${result.id} stdout`);
  const stderr = boundedText(result.stderr, `${result.id} stderr`);
  return {
    id: result.id,
    command: result.command,
    args: [...result.args],
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: exactNonNegativeInteger(result.durationMs, `${result.id} durationMs`),
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
    signal: result.signal ?? null,
    stdoutFile: `commands/${result.id}.stdout`,
    stderrFile: `commands/${result.id}.stderr`,
    stdoutBytes: stdout.byteLength,
    stderrBytes: stderr.byteLength,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
}

/**
 * Creates a V1 software record only. It deliberately cannot mark hardware,
 * site, pilot, or production qualification as passed.
 */
export function createV1ValidationRecord({ release, commandResults, generatedAt = new Date().toISOString(), environment = {} }) {
  const checkedRelease = validateRelease(release);
  const commands = commandResults.map(publicCommandResult);
  const unit = commandResults.find((result) => result.id === "unit");
  if (!unit) throw new Error("The V1 unit-test command result is required");
  const testSummary = parseVitestSummary(unit.stdout);
  const requiredIds = new Set(V1_COMMANDS.map((entry) => entry.id));
  const observedIds = new Set(commands.map((entry) => entry.id));
  const allCommandsPresent = [...requiredIds].every((id) => observedIds.has(id));
  const allCommandsPassed = allCommandsPresent
    && commands.every((entry) => entry.exitCode === 0 && entry.signal === null)
    && testSummary.failedTestFiles === 0
    && testSummary.failedTests === 0
    && testSummary.failedSuites === 0
    && testSummary.skippedTestFiles === 0
    && testSummary.skippedSuites === 0
    && testSummary.skippedTests === 0;
  return {
    schemaVersion: 1,
    recordType: "rf-monitor-validation",
    gate: "V1",
    generatedAt,
    release: checkedRelease,
    environment: {
      nodeVersion: environment.nodeVersion ?? process.version,
      nodeExecutable: environment.nodeExecutable ?? process.execPath,
      osPlatform: environment.osPlatform ?? os.platform(),
      osRelease: environment.osRelease ?? os.release(),
      architecture: environment.architecture ?? os.arch(),
      logicalCpuCount: environment.logicalCpuCount ?? os.cpus().length,
    },
    result: {
      state: allCommandsPassed ? "passed" : "failed",
      softwareGatePassed: allCommandsPassed,
      productionReady: false,
      physicalQualification: "not-run",
    },
    testSummary,
    commands,
    hashes: {
      source: checkedRelease.sourceDigest,
      package: checkedRelease.packageDigest,
      dependencyLock: checkedRelease.dependencyLockDigest,
    },
    gateStatus: {
      V0: allCommandsPassed ? "passed" : "failed",
      V1: allCommandsPassed ? "passed" : "failed",
      V2: "not-run",
      V3: "not-run",
      V4: "not-run",
      V5: "not-run",
      V6: "not-run",
      V7: "not-run",
    },
    limitations: [
      "V1 is software evidence only.",
      "No physical receiver, RF chain, operator, backup, or managed-switch qualification is implied.",
    ],
  };
}

async function writeExclusive(filePath, value) {
  const handle = await open(filePath, "wx", 0o440);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeBundleName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/.test(value)) throw new Error("Validation bundle name is invalid");
  return value;
}

export async function publishV1Bundle({ outputRoot, bundleName, record, commandResults }) {
  const destinationRoot = path.resolve(outputRoot);
  const finalName = safeBundleName(bundleName);
  const finalPath = path.join(destinationRoot, finalName);
  const temporaryPath = path.join(destinationRoot, `.partial-${process.pid}-${randomUUID()}`);
  await mkdir(destinationRoot, { recursive: true });
  await mkdir(path.join(temporaryPath, "commands"), { recursive: true, mode: 0o750 });
  try {
    const manifestLines = [];
    for (const result of commandResults) {
      for (const stream of ["stdout", "stderr"]) {
        const contents = boundedText(result[stream], `${result.id} ${stream}`);
        const relative = `commands/${result.id}.${stream}`;
        await writeExclusive(path.join(temporaryPath, relative), contents);
        manifestLines.push(`${sha256(contents)}  ${relative}`);
      }
    }
    const recordContents = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await writeExclusive(path.join(temporaryPath, "record.json"), recordContents);
    manifestLines.push(`${sha256(recordContents)}  record.json`);
    await writeExclusive(path.join(temporaryPath, "SHA256SUMS"), `${manifestLines.sort().join("\n")}\n`);
    await chmod(path.join(temporaryPath, "commands"), 0o550);
    await chmod(temporaryPath, 0o550);
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await chmod(temporaryPath, 0o750).catch(() => undefined);
    await chmod(path.join(temporaryPath, "commands"), 0o750).catch(() => undefined);
    await rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function executeCommand(specification, repositoryRoot = REPOSITORY_ROOT) {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  return new Promise((resolve, reject) => {
    const child = spawn(specification.command, specification.args, {
      cwd: repositoryRoot,
      // Production and qualification use the Ubuntu system runtime. Do not let
      // an interactive NVM installation select a different Node executable.
      env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let killedForBound = false;
    const append = (chunks, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        killedForBound = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (killedForBound) return reject(new Error(`${specification.id} output exceeded the validation bound`));
      const completedMs = Date.now();
      resolve({
        ...specification,
        startedAt,
        completedAt: new Date(completedMs).toISOString(),
        durationMs: Math.max(0, completedMs - startedMs),
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export async function runV1Validation({
  repositoryRoot = REPOSITORY_ROOT,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  execute = executeCommand,
  validatePublicationCandidate = validateV1PublicationCandidate,
  publish = publishV1Bundle,
} = {}) {
  const commandResults = [];
  for (const command of V1_COMMANDS) commandResults.push(await execute(command, repositoryRoot));
  const release = await validatePublicationCandidate({ repositoryRoot });
  const generatedAt = new Date().toISOString();
  const record = createV1ValidationRecord({ release, commandResults, generatedAt });
  const timestamp = generatedAt.replace(/[-:.]/g, "");
  const destination = await publish({
    outputRoot,
    bundleName: `${timestamp}-${release.buildId}`,
    record,
    commandResults,
  });
  return { destination, record };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const arguments_ = parseV1Arguments(process.argv.slice(2));
    if (arguments_.help) {
      process.stdout.write(V1_HELP);
    } else {
      const { destination, record } = await runV1Validation();
      process.stdout.write(`${JSON.stringify({ destination, gate: record.gate, result: record.result, testSummary: record.testSummary }, null, 2)}\n`);
      if (!record.result.softwareGatePassed) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
